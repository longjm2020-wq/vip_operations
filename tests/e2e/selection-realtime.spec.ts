import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { selectionBaseFields } from "../../packages/contracts/src/selection-migration.js";

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
  let connectionAttempts = 0;
  await page.route("**/api/v1/style-selections/events", async (route) => {
    if (++connectionAttempts === 1)
      await route.fulfill({ status: 404, body: "restarting" });
    else await route.continue();
  });
  await openTable(page);
  expect(connectionAttempts).toBeGreaterThan(1);
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

test("transfer fields and rows reach already-open empty targets for the sender and a read-only account", async ({
  page,
  browser,
}) => {
  const csrf = await login(page),
    suffix = randomUUID().slice(0, 8),
    password = randomUUID();
  const role = await api(page, csrf, "/roles", "POST", {
    code: "FIELD_VIEW_" + suffix,
    name: "传送字段只读",
    permissionCodes: ["project.read"],
  });
  await api(page, csrf, "/users", "POST", {
    username: "field-view-" + suffix,
    displayName: "字段只读",
    password,
    roleIds: [role.id],
  });
  const target = await api(page, csrf, "/project-tables", "POST", {
    name: "字段同步-" + suffix,
    visibility: "PUBLIC",
  });
  const source = await api(page, csrf, "/style-selections", "POST", {
    xutiStyleNo: "FIELDS-" + suffix,
    material: "共享材质内容",
  });
  const viewerContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const viewer = await viewerContext.newPage();
  try {
    await login(viewer, "field-view-" + suffix, password);
    for (const tab of [page, viewer]) {
      await tab.goto("/project-tables/" + target.id);
      await expect(tab.locator(".selection-sheet")).toHaveAttribute(
        "data-realtime-connected",
        "true",
      );
      await expect(tab.locator("thead th[data-selection-column]")).toHaveCount(
        0,
      );
    }
    // Both accounts have saved an explicitly empty personal layout before the transfer.
    await expect
      .poll(
        async () =>
          (
            await api(
              page,
              csrf,
              "/style-selections/layout-preferences?tableId=" + target.id,
              "GET",
            )
          ).revision,
      )
      .toBeGreaterThan(0);
    const body = {
      target: String(target.id),
      rowIds: [String(source.id)],
      fields: selectionBaseFields.filter((field) =>
        ["xutiStyleNo", "material"].includes(field.key),
      ),
      mappings: [],
      copyMissingFields: true,
    };
    const preview = await api(
      page,
      csrf,
      "/style-selections/migration/preview",
      "POST",
      body,
    );
    await api(page, csrf, "/style-selections/migration", "POST", {
      ...body,
      token: preview.token,
    });
    for (const tab of [page, viewer]) {
      await expect(
        tab.locator('thead th[data-selection-column="material"]'),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        tab.getByRole("textbox", { name: "材质成分", exact: true }),
      ).toHaveValue("共享材质内容");
      await expect(
        tab.getByRole("textbox", { name: "序缇款号", exact: true }),
      ).toHaveValue("FIELDS-" + suffix);
    }
    await expect(
      viewer.getByRole("textbox", { name: "材质成分", exact: true }),
    ).toHaveAttribute("readonly", "");
    await viewer.reload();
    await expect(
      viewer.getByRole("textbox", { name: "材质成分", exact: true }),
    ).toHaveValue("共享材质内容");
  } finally {
    await viewerContext.close();
  }
});

test("format-only writes and public layout changes reach a read-only browser without exposing denied formats", async ({
  page,
  browser,
}) => {
  const csrf = await login(page), suffix = randomUUID().slice(0, 8), password = randomUUID();
  const role = await api(page, csrf, "/roles", "POST", {
    code: "FORMAT_VIEW_" + suffix, name: "格式实时只读测试", permissionCodes: ["selection.read"],
  });
  await api(page, csrf, "/users", "POST", {
    username: "format-view-" + suffix, displayName: "格式只读测试", password, roleIds: [role.id],
  });
  const row = await api(page, csrf, "/style-selections", "POST", {
    xutiStyleNo: "FORMAT-LIVE-" + suffix, material: "原始内容保持不变", supplyPriceExclTax: "42.50",
  });
  let layout = await api(page, csrf, "/style-selections/layout-preferences?shared=true", "GET");
  if (!layout.sharedPreferences) layout = await api(page, csrf, "/style-selections/layout-preferences/initialize", "POST", {});
  const originalShared = layout.sharedPreferences;
  const originalProtection = await api(page, csrf, "/style-selections/protection", "GET");
  await openTable(page);
  const viewer = await peer(browser, "format-view-" + suffix, password);
  const price = cell(viewer.page, row.id, "supplyPriceExclTax");
  const formatMaps = {
    cellColors: { supplyPriceExclTax: "BLUE", material: "GREEN" },
    cellAlignments: { supplyPriceExclTax: "right", material: "left" },
    cellVerticalAlignments: { supplyPriceExclTax: "top", material: "bottom" },
    cellTextColors: { supplyPriceExclTax: "#0958d9", material: "#389e0d" },
    cellNumberFormats: { supplyPriceExclTax: { type: "currency", decimals: 2 }, material: { type: "text" } },
  };
  try {
    // No field value changes: only formatting advances the row and stream token.
    await api(page, csrf, "/style-selections/" + row.id, "PATCH", {
      ...formatMaps, expectedUpdatedAt: row.updatedAt,
    });
    await expect(price.locator(".selection-formatted-value")).toHaveText("¥ 42.50", { timeout: 4000 });
    await expect(price.locator(".selection-formatted-value")).toHaveAttribute("aria-readonly", "true");
    await expect(price).toHaveCSS("background-color", "rgb(237, 245, 255)");
    await expect(price).toHaveCSS("color", "rgb(9, 88, 217)");
    await expect(price).toHaveCSS("text-align", "right");
    await expect(price).toHaveAttribute("data-vertical-align", "top");
    const saved = await api(page, csrf, "/style-selections/" + row.id, "GET");
    expect(saved.supplyPriceExclTax).toBe("42.50");
    expect(saved.material).toBe("原始内容保持不变");

    // Public column widths and row height follow the same live field invalidation.
    layout = await api(page, csrf, "/style-selections/layout-preferences?shared=true", "GET");
    await api(page, csrf, "/style-selections/layout-preferences?shared=true", "POST", {
      preferences: layout.preferences, revision: layout.revision, sharedRevision: layout.sharedRevision,
      sharedChanges: {
        rowHeight: "compact",
        columns: layout.sharedPreferences.columns.map((field: { key: string; width: number }) => field.key === "supplierStyleNo" ? { ...field, width: 243 } : field),
      },
    });
    await expect(viewer.page.locator(".selection-sheet")).toHaveClass(/row-compact/, { timeout: 4000 });
    await expect(viewer.page.locator('thead th[data-selection-column="supplierStyleNo"]')).toHaveCSS("width", "243px");

    // Clearing formatting is also visible promptly; default cell display returns.
    await api(page, csrf, "/style-selections/" + row.id, "PATCH", {
      expectedUpdatedAt: saved.updatedAt,
      ...Object.fromEntries(Object.keys(formatMaps).map((key) => [key, { supplyPriceExclTax: null }])),
    });
    await expect(price.locator(".selection-formatted-value")).toHaveCount(0, { timeout: 4000 });
    await expect(price.locator("input")).toHaveValue("42.50");
    await expect(price).toHaveCSS("text-align", "center");
    await expect(price).not.toHaveCSS("color", "rgb(9, 88, 217)");

    await api(page, csrf, "/style-selections/" + row.id, "PATCH", formatMaps);
    const protection = await api(page, csrf, "/style-selections/protection", "GET");
    await api(page, csrf, "/style-selections/protection", "POST", {
      revision: protection.revision,
      settings: { ...protection.settings, enabled: true, regions: [...protection.settings.regions, {
        id: randomUUID(), name: "格式查看过滤", scope: "cells", rowIds: [row.id], columnKeys: ["supplyPriceExclTax"], users: {}, others: "deny",
      }] },
    });
    await expect(price).toContainText("••••", { timeout: 4000 });
    await expect(price.locator(".selection-formatted-value,input")).toHaveCount(0);
    await expect(price).not.toHaveCSS("background-color", "rgb(237, 245, 255)");
    await expect(price).not.toHaveCSS("color", "rgb(9, 88, 217)");
    const viewerCsrf = (await (await viewer.page.request.get("/api/v1/auth/me")).json()).data.csrfToken;
    const scoped = await api(viewer.page, viewerCsrf, "/style-selections/sync", "POST", { known: {} });
    const filteredRow = scoped.data.find((item: { id: string }) => String(item.id) === String(row.id));
    expect(filteredRow.supplyPriceExclTax).toBeNull();
    for (const key of Object.keys(formatMaps)) {
      expect(filteredRow[key]).not.toHaveProperty("supplyPriceExclTax");
      expect(filteredRow[key]).toHaveProperty("material");
    }
  } finally {
    await viewer.context.close();
    const protection = await api(page, csrf, "/style-selections/protection", "GET");
    await api(page, csrf, "/style-selections/protection", "POST", { revision: protection.revision, settings: originalProtection.settings });
    layout = await api(page, csrf, "/style-selections/layout-preferences?shared=true", "GET");
    await api(page, csrf, "/style-selections/layout-preferences?shared=true", "POST", {
      preferences: layout.preferences, revision: layout.revision, sharedRevision: layout.sharedRevision, sharedChanges: originalShared,
    });
  }
});
