import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function login(
  page: Page,
  username = "admin",
  password = process.env.E2E_PASSWORD!,
) {
  const response = await page.request.post("/api/v1/auth/login", {
    data: { username, password },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).data.csrfToken as string;
}
async function api(
  page: Page,
  csrf: string,
  path: string,
  method = "POST",
  data?: unknown,
) {
  const response = await page.request.fetch("/api/v1" + path, {
    method,
    headers: {
      Origin: "http://127.0.0.1:5174",
      "X-CSRF-Token": csrf,
      "Idempotency-Key": randomUUID(),
    },
    ...(data ? { data } : {}),
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).data;
}
const cell = (page: Page, id: string, column: string) =>
  page.locator(
    `td[data-selection-row="${id}"][data-selection-column="${column}"]`,
  );
async function openTable(page: Page) {
  await page.goto("/style-selections");
  await expect(page.locator(".selection-sheet")).toHaveAttribute(
    "data-realtime-connected",
    "true",
  );
}
async function peer(
  browser: Browser,
  username = "admin",
  password = process.env.E2E_PASSWORD!,
) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await login(page, username, password);
  await openTable(page);
  return { page, context };
}

test("saved cell edits reach a read-only browser promptly and hidden cells remain masked", async ({
  page,
  browser,
}) => {
  const csrf = await login(page),
    suffix = randomUUID().slice(0, 8),
    password = randomUUID();
  const role = await api(page, csrf, "/roles", "POST", {
    code: "VIEW_" + suffix,
    name: "实时只读测试",
    permissionCodes: ["selection.read"],
  });
  await api(page, csrf, "/users", "POST", {
    username: "view-" + suffix,
    displayName: "只读测试",
    password,
    roleIds: [role.id],
  });
  const row = await api(page, csrf, "/style-selections", "POST", {
    xutiStyleNo: "REALTIME-" + suffix,
    material: "before",
  });
  await openTable(page);
  const viewer = await peer(browser, "view-" + suffix, password);
  try {
    await expect(
      cell(viewer.page, row.id, "material").getByRole("textbox"),
    ).toHaveAttribute("readonly", "");
    await cell(page, row.id, "material")
      .getByRole("textbox")
      .fill("after save");
    await expect(
      cell(viewer.page, row.id, "material").getByRole("textbox"),
    ).toHaveValue("after save", { timeout: 4000 });
    await viewer.context.setOffline(true);
    await expect(viewer.page.locator(".selection-sheet")).toHaveAttribute(
      "data-realtime-connected",
      "false",
    );
    const beforeReconnect = await api(
      page,
      csrf,
      "/style-selections/" + row.id,
      "GET",
    );
    await api(page, csrf, "/style-selections/" + row.id, "PATCH", {
      material: "changed while disconnected",
      expectedUpdatedAt: beforeReconnect.updatedAt,
    });
    await viewer.context.setOffline(false);
    await expect(
      cell(viewer.page, row.id, "material").getByRole("textbox"),
    ).toHaveValue("changed while disconnected", { timeout: 5000 });
    const protection = await api(
      page,
      csrf,
      "/style-selections/protection",
      "GET",
    );
    await api(page, csrf, "/style-selections/protection", "POST", {
      revision: protection.revision,
      settings: {
        enabled: true,
        claimsEnabled: false,
        autoHide: false,
        hiddenReaders: [],
        regions: [
          {
            id: randomUUID(),
            name: "private",
            scope: "cells",
            rowIds: [row.id],
            columnKeys: ["material"],
            users: {},
            others: "deny",
          },
        ],
      },
    });
    await expect(cell(viewer.page, row.id, "material")).toContainText("••••", {
      timeout: 4000,
    });
    const fresh = await api(page, csrf, "/style-selections/" + row.id, "GET");
    const payload = viewer.page.waitForResponse(
      (response) =>
        response.url().includes("/style-selections/sync") &&
        response.request().method() === "POST",
    );
    await api(page, csrf, "/style-selections/" + row.id, "PATCH", {
      material: "SECRET-NEW-VALUE",
      expectedUpdatedAt: fresh.updatedAt,
    });
    const result = await (await payload).text();
    expect(result).not.toContain("SECRET-NEW-VALUE");
    await expect(cell(viewer.page, row.id, "material")).toContainText("••••");
    await api(page, csrf, "/roles/" + role.id, "PATCH", {
      name: "实时只读测试",
      permissionCodes: [],
    });
    await expect(viewer.page.locator("td[data-selection-row]")).toHaveCount(0, {
      timeout: 4000,
    });
  } finally {
    await viewer.context.close();
  }
});

test("a failed local draft does not freeze remote rows or get replaced by them", async ({
  page,
  browser,
}) => {
  const csrf = await login(page),
    suffix = randomUUID().slice(0, 8);
  const local = await api(page, csrf, "/style-selections", "POST", {
    xutiStyleNo: "LOCAL-" + suffix,
    material: "local before",
  });
  const remote = await api(page, csrf, "/style-selections", "POST", {
    xutiStyleNo: "REMOTE-" + suffix,
    material: "remote before",
  });
  await openTable(page);
  const other = await peer(browser);
  try {
    const price = cell(page, local.id, "supplyPriceExclTax");
    await price.getByRole("textbox").fill("-1");
    await expect(price).toHaveClass(/selection-cell-error/);
    await cell(other.page, remote.id, "material")
      .getByRole("textbox")
      .fill("remote live update");
    await expect(
      cell(page, remote.id, "material").getByRole("textbox"),
    ).toHaveValue("remote live update", { timeout: 4000 });
    await expect(price.getByRole("textbox")).toHaveValue("-1");
  } finally {
    await other.context.close();
  }
});

test("a simultaneous edit to the same cell retains the local draft and reports a conflict", async ({
  page,
  browser,
}) => {
  const csrf = await login(page),
    suffix = randomUUID().slice(0, 8);
  const row = await api(page, csrf, "/style-selections", "POST", {
    xutiStyleNo: "COLLISION-" + suffix,
    material: "before",
  });
  await openTable(page);
  const other = await peer(browser);
  try {
    const local = cell(page, row.id, "material");
    await local.getByRole("textbox").fill("local pending");
    await api(
      other.page,
      (
        await other.page.request
          .get("/api/v1/auth/me")
          .then((response) => response.json())
      ).data.csrfToken,
      "/style-selections/" + row.id,
      "PATCH",
      { material: "remote saved", expectedUpdatedAt: row.updatedAt },
    );
    await expect(local).toHaveClass(/selection-cell-error/, { timeout: 4000 });
    await expect(local).toHaveAttribute("title", /其他用户修改/);
    await expect(local.getByRole("textbox")).toHaveValue("local pending");
    await expect(
      cell(other.page, row.id, "material").getByRole("textbox"),
    ).toHaveValue("remote saved");
    await expect(
      page.getByRole("button", { name: "未保存 · 重试" }),
    ).toBeVisible();
    const stored = await api(page, csrf, "/style-selections/" + row.id, "GET");
    expect(stored.material).toBe("remote saved");
  } finally {
    await other.context.close();
  }
});
