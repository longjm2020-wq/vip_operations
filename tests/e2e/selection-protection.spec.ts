import { expect, test, type Page } from "@playwright/test";
import {
  defaultProtection,
  selectionFields,
  type SelectionProtection,
} from "../../packages/contracts/src/selection-protection.js";

async function mockProtection(
  page: Page,
  initial: SelectionProtection,
  canManage = true,
) {
  let settings = structuredClone(initial),
    revision = 0;
  await page.route("**/api/v1/style-selections/protection", async (route) => {
    if (route.request().method() === "POST") {
      settings = route.request().postDataJSON().settings;
      revision++;
    }
    await route.fulfill({ json: { data: { settings, revision, canManage } } });
  });
}

const protectionSave = (page: Page) =>
  page.waitForRequest(
    (request) =>
      request.url().endsWith("/protection") && request.method() === "POST",
  );

async function openAutoHide(page: Page) {
  await page.getByRole("button", { name: "保护区域", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "内容自动隐藏", exact: true })
    .click();
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "style-selection-custom-columns-v1",
      JSON.stringify([
        {
          key: "custom:note",
          label: "备注资料",
          width: 150,
          custom: true,
          type: "text",
        },
      ]),
    ),
  );
  let revision = 0,
    settings = { ...defaultProtection };
  let personalLayout: { preferences: unknown; revision: number } = {
    preferences: null,
    revision: 0,
  };
  const rows = Array.from({ length: 3 }, (_, index) => ({
    id: String(index + 1),
    xutiStyleNo: `STYLE-${index + 1}`,
    color: "白",
    material: "棉",
    sortOrder: index,
    images: [],
    labelImages: [],
    extraFields: { "custom:note": "保留资料" },
    createdBy: "1",
    createdByName: "管理员",
    createdByUsername: "admin",
    updatedBy: "2",
    updatedByName: "采购",
    updatedByUsername: "buyer",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T01:00:00Z",
    cellAccess: Object.fromEntries(selectionFields.map((key) => [key, "edit"])),
    defaultCellAccess: "edit",
    policyRevision: 0,
  }));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: any = [];
    if (path.endsWith("/layout-preferences")) {
      if (route.request().method() === "POST")
        personalLayout = {
          preferences: route.request().postDataJSON().preferences,
          revision: personalLayout.revision + 1,
        };
      data = personalLayout;
    }
    if (path.endsWith("/auth/me"))
      data = {
        id: "1",
        displayName: "管理员",
        permissions: ["selection.read", "selection.manage"],
        roleCodes: ["ADMIN"],
        csrfToken: "test",
      };
    if (path.endsWith("/revision")) data = { revision: "fixture-" + revision };
    if (path.endsWith("/sync"))
      data = {
        revision: "fixture-" + revision,
        index: rows.map((row) => ({ id: row.id, token: "r" + revision })),
        data: rows.map((row) => ({ ...row, policyRevision: revision })),
      };
    if (path.endsWith("/shared-view"))
      data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/protection/users"))
      data = [
        { id: "1", displayName: "管理员", username: "admin" },
        { id: "2", displayName: "采购", username: "buyer" },
      ];
    if (path.endsWith("/protection")) {
      if (route.request().method() === "POST") {
        settings = route.request().postDataJSON().settings;
        revision++;
      }
      data = { settings, revision, canManage: true };
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(
    page.locator('td[data-selection-column="xutiStyleNo"]'),
  ).toHaveCount(3);
});
test("field deletion confirms, persists and cancels selection without a deleted-field entry", async ({
  page,
}) => {
  await page
    .locator('td[data-selection-row="1"][data-selection-column="material"]')
    .click();
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "删除字段材质", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(
    page.locator('td[data-selection-column="material"]'),
  ).toHaveCount(3);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "删除字段材质", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除字段", exact: true })
    .click();
  await expect(
    page.locator('td[data-selection-column="material"]'),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("编辑当前单元格", { exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.locator('td[data-selection-column="xutiStyleNo"]'),
  ).toHaveCount(3);
  await expect(
    page.locator('td[data-selection-column="material"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑字段材质", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /已删除字段/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "字段类型管理", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "添加字段", exact: true }),
  ).toBeVisible();
});

test("deleted custom fields keep record data while a new same-name field starts empty", async ({
  page,
}) => {
  const cell = page.locator(
    'td[data-selection-row="1"][data-selection-column="custom:note"]',
  );
  await expect(cell).toContainText("保留资料");
  const recordWrites: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/style-selections(?:\/\d+)?$/.test(new URL(request.url()).pathname)
    )
      recordWrites.push(request.url());
  });
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page
    .getByRole("button", { name: "删除字段备注资料", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除字段", exact: true })
    .click();
  await page.reload();
  await expect(cell).toHaveCount(0);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await expect(page.getByRole("button", { name: /已删除字段/ })).toHaveCount(0);
  await page.getByRole("button", { name: "添加字段", exact: true }).click();
  await page
    .getByRole("dialog", { name: "添加字段", exact: true })
    .getByLabel("字段名称", { exact: true })
    .fill("备注资料");
  await page
    .getByRole("dialog", { name: "添加字段", exact: true })
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const newKey = await page
    .getByRole("columnheader", { name: "选择整列：备注资料", exact: true })
    .getAttribute("data-selection-column");
  expect(newKey).not.toBe("custom:note");
  await expect(
    page
      .locator(`td[data-selection-row="1"][data-selection-column="${newKey}"]`)
      .getByRole("textbox"),
  ).toHaveValue("");
  expect(recordWrites).toEqual([]);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page
    .getByRole("button", { name: "编辑字段备注资料", exact: true })
    .click();
  await expect(page.getByLabel("字段名称", { exact: true })).toHaveValue(
    "备注资料",
  );
  await expect(page.getByLabel("字段类型", { exact: true })).toHaveValue("");
  await expect(page.getByRole("dialog")).toContainText("文本");
});

test("deleted shared-filter field does not keep rows filtered after reload", async ({
  page,
}) => {
  await page.route("**/api/v1/style-selections/shared-view", (route) =>
    route.fulfill({
      json: {
        data: {
          revision: 1,
          view: {
            filters: { material: { mode: "equals", value: "丝绸" } },
            sort: { key: "material", direction: "asc" },
          },
        },
      },
    }),
  );
  await page.reload();
  await expect(
    page.locator('td[data-selection-column="xutiStyleNo"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "删除字段材质", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除字段", exact: true })
    .click();
  await expect(
    page.locator('td[data-selection-column="xutiStyleNo"]'),
  ).toHaveCount(3);
  await page.reload();
  await expect(
    page.locator('td[data-selection-column="xutiStyleNo"]'),
  ).toHaveCount(3);
  await expect(
    page.locator('td[data-selection-column="material"]'),
  ).toHaveCount(0);
});

test("read-only users cannot delete field definitions and see no recovery controls", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      json: {
        data: {
          id: "3",
          displayName: "查看者",
          permissions: ["selection.read"],
          roleCodes: [],
          csrfToken: "test",
        },
      },
    }),
  );
  await page.reload();
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "删除字段材质", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /已删除字段|恢复字段/ }),
  ).toHaveCount(0);
});
test("administrator configures a selected region, named-user access and independent default rights", async ({
  page,
}) => {
  await page
    .locator('td[data-selection-row="1"][data-selection-column="material"]')
    .click();
  await page.getByRole("button", { name: "保护区域", exact: true }).click();
  await page.getByText("区域权限", { exact: true }).click();
  await page.getByRole("button", { name: "添加保护区域" }).click();
  await expect(page.getByLabel("保护范围", { exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByLabel("保护区域名称").fill("材质资料");
  await page.getByLabel("添加指定用户", { exact: true }).click();
  await page.getByText("采购（buyer）", { exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("用户 2 权限", { exact: true }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("仅查看", { exact: true })
    .click();
  await page.getByLabel("其他人权限", { exact: true }).click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const request = page.waitForRequest(
    (request) =>
      request.url().endsWith("/protection") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "确定", exact: true }).click();
  const config = (await request).postDataJSON().settings;
  expect(config.regions[0]).toMatchObject({
    name: "材质资料",
    scope: "cells",
    rowIds: ["1"],
    columnKeys: ["material"],
    users: { "1": "edit", "2": "read" },
    others: "deny",
  });
  await expect(page.getByText("材质资料", { exact: true })).toBeVisible();
  const enable = page.waitForRequest(
    (request) =>
      request.url().endsWith("/protection") && request.method() === "POST",
  );
  await page.getByLabel("开启区域权限", { exact: true }).click();
  expect((await enable).postDataJSON().settings.enabled).toBe(true);
});
test("scoped content hiding preserves access regions and disables after deleting its last area", async ({
  page,
}) => {
  const accessRegions: SelectionProtection["regions"] = [
    {
      id: "5a13483d-cd30-4783-9300-2be8bfaad922",
      name: "已有区域权限",
      scope: "rows",
      rowIds: ["2"],
      columnKeys: [],
      users: { "1": "edit", "2": "read" },
      others: "deny",
    },
  ];
  await mockProtection(page, {
    ...defaultProtection,
    enabled: true,
    regions: accessRegions,
  });
  await page.reload();
  await page
    .locator('td[data-selection-row="1"][data-selection-column="material"]')
    .click();
  await openAutoHide(page);
  const enabled = page.getByLabel("开启内容自动隐藏", { exact: true });
  await expect(enabled).toBeDisabled();
  await page.getByRole("button", { name: /添加隐藏区域$/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "设置隐藏区域",
    exact: true,
  });
  await expect(dialog.getByText("选中单元格", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("隐藏范围", { exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await dialog.getByLabel("隐藏区域名称", { exact: true }).fill("材质隐藏区");
  const saving = protectionSave(page);
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  const saved = (await saving).postDataJSON().settings;
  expect(saved.autoHideRegions).toEqual([
    expect.objectContaining({
      name: "材质隐藏区",
      scope: "cells",
      rowIds: ["1"],
      columnKeys: ["material"],
    }),
  ]);
  expect(saved.regions).toEqual(accessRegions);
  expect(saved.enabled).toBe(true);
  expect(saved.autoHide).toBe(false);
  await expect(dialog).not.toBeVisible();
  await expect(enabled).toBeEnabled();
  const enabling = protectionSave(page);
  await enabled.click();
  const active = (await enabling).postDataJSON().settings;
  expect(active.autoHide).toBe(true);
  expect(active.autoHideRegions).toEqual(saved.autoHideRegions);
  expect(active.regions).toEqual(accessRegions);
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: ".local/auto-hide-regions-ui.png" });
  const deleting = protectionSave(page);
  await page
    .getByRole("button", { name: "删除隐藏区域材质隐藏区", exact: true })
    .click();
  const removed = (await deleting).postDataJSON().settings;
  expect(removed.autoHideRegions).toEqual([]);
  expect(removed.autoHide).toBe(false);
  expect(removed.regions).toEqual(accessRegions);
  await expect(enabled).toBeDisabled();
  await expect(enabled).toHaveAttribute("aria-checked", "false");
});

test("scoped content hiding applies entire columns to all rows without saving stale row selection", async ({
  page,
}) => {
  await page
    .locator('td[data-selection-row="1"][data-selection-column="material"]')
    .click();
  await openAutoHide(page);
  await page.getByRole("button", { name: /添加隐藏区域$/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "设置隐藏区域",
    exact: true,
  });
  await dialog.getByLabel("隐藏区域名称", { exact: true }).fill("整列材质");
  await dialog.getByLabel("隐藏范围", { exact: true }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("整列（所有行）", { exact: true })
    .click();
  await expect(dialog.getByLabel("隐藏行", { exact: true })).toHaveCount(0);
  const saving = protectionSave(page);
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  expect((await saving).postDataJSON().settings).toMatchObject({
    autoHide: false,
    autoHideRegions: [
      {
        name: "整列材质",
        scope: "columns",
        rowIds: [],
        columnKeys: ["material"],
      },
    ],
    regions: [],
  });
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "编辑隐藏区域整列材质", exact: true })
    .click();
  await expect(
    dialog.locator('.ant-select-content[title="整列（所有行）"]'),
  ).toBeVisible();
  await expect(dialog.getByLabel("隐藏行", { exact: true })).toHaveCount(0);
});

test("scoped content hiding starts with an empty cell area when there is no selection", async ({
  page,
}) => {
  await openAutoHide(page);
  await expect(
    page.getByLabel("开启内容自动隐藏", { exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: /添加隐藏区域$/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "设置隐藏区域",
    exact: true,
  });
  await expect(dialog.getByText("选中单元格", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("隐藏行", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("隐藏字段", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "确定", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByLabel("开启内容自动隐藏", { exact: true }),
  ).toHaveAttribute("aria-checked", "false");
});

test("read-only users cannot manage scoped content hiding", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      json: {
        data: {
          id: "3",
          displayName: "查看者",
          permissions: ["selection.read"],
          roleCodes: [],
          csrfToken: "test",
        },
      },
    }),
  );
  await mockProtection(
    page,
    {
      ...defaultProtection,
      autoHide: true,
      autoHideRegions: [
        {
          id: "f760fa89-d5d7-43ac-a323-9e6d38076187",
          name: "受限材质",
          scope: "columns",
          rowIds: [],
          columnKeys: ["material"],
        },
      ],
    },
    false,
  );
  await page.reload();
  await openAutoHide(page);
  await expect(
    page.getByLabel("开启内容自动隐藏", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("开启内容自动隐藏", { exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: /添加隐藏区域$/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /编辑隐藏区域|删除隐藏区域/ }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("自动隐藏指定查看人", { exact: true }),
  ).toHaveCount(0);
});

test("date cells keep plain table styling, manual editing and read-only values", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("selection-field-types-initialized-v2", "true");
    localStorage.setItem(
      "selection-field-config-v1",
      JSON.stringify({ registrationBatch: { type: "date" } }),
    );
    localStorage.removeItem("selection-layout-v2:1");
  });
  let dateLayout: { preferences: unknown; revision: number } = {
    preferences: null,
    revision: 0,
  };
  await page.route(
    "**/api/v1/style-selections/layout-preferences*",
    async (route) => {
      if (route.request().method() === "POST")
        dateLayout = {
          preferences: route.request().postDataJSON().preferences,
          revision: dateLayout.revision + 1,
        };
      await route.fulfill({ json: { data: dateLayout } });
    },
  );
  const rows = Array.from({ length: 3 }, (_, index) => ({
    id: String(index + 1),
    xutiStyleNo: `STYLE-${index + 1}`,
    registrationBatch: "2026-10-01",
    images: [],
    labelImages: [],
    color: "白",
    material: "棉",
    extraFields: {},
    sortOrder: index,
    migrationLocked: index === 1,
    cellAccess: Object.fromEntries(selectionFields.map((key) => [key, "edit"])),
    defaultCellAccess: "edit",
    policyRevision: 0,
  }));
  await page.route("**/api/v1/style-selections/sync*", (route) =>
    route.fulfill({
      json: {
        data: {
          revision: "fixture-0",
          index: rows.map((row) => ({ id: row.id, token: "r0" })),
          data: rows,
        },
      },
    }),
  );
  await page.reload();
  const editableCell = page.locator(
    'td[data-selection-row="1"][data-selection-column="registrationBatch"]',
  );
  const editableDate = editableCell.getByLabel("登记批次", { exact: true });
  await expect(editableDate).toHaveValue("2026-10-01");
  await expect(editableDate).toHaveClass("selection-date-input");
  expect(
    await editableDate.evaluate((input: HTMLInputElement) => ({
      border: getComputedStyle(input).borderTopWidth,
      background: getComputedStyle(input).backgroundColor,
      readOnly: input.readOnly,
      type: input.type,
    })),
  ).toEqual({
    border: "0px",
    background: "rgba(0, 0, 0, 0)",
    readOnly: false,
    type: "text",
  });
  await editableDate.fill("2026-10-10");
  await expect(editableDate).toHaveValue("2026-10-10");
  await expect(
    page.locator('.selection-editor-control input[aria-label="登记批次"]'),
  ).toHaveAttribute("type", "date");
  const lockedDate = page
    .locator(
      'td[data-selection-row="2"][data-selection-column="registrationBatch"]',
    )
    .getByLabel("登记批次", { exact: true });
  await expect(lockedDate).toHaveValue("2026-10-01");
  await expect(lockedDate).toHaveJSProperty("readOnly", true);
  await expect(lockedDate).toBeEnabled();
  await lockedDate.click();
  await expect(
    page.locator('.selection-editor-control input[aria-label="登记批次"]'),
  ).toBeDisabled();
  await page.screenshot({ path: ".local/date-cell-ui.png" });
});

test("keeps fixed grouping / sorting choices and lets users opt into other fields", async ({
  page,
}) => {
  await page.getByLabel("分组方式", { exact: true }).click();
  await expect(
    page.locator(
      ".ant-select-dropdown:visible .ant-select-item-option-content",
    ),
  ).toHaveText([
    "不分组",
    "按登记批次分组",
    "按供应商编码分组",
    "配置分组字段",
  ]);
  await page.getByText("配置分组字段", { exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("checkbox", { name: "颜色", exact: true }).check();
  await modal.getByRole("button", { name: "确定", exact: true }).click();
  await page.getByLabel("分组方式", { exact: true }).click();
  await page.getByText("按颜色分组", { exact: true }).click();
  await expect(page.locator(".selection-group-row")).toContainText("白");
  await page.getByLabel("排序方式", { exact: true }).click();
  await page.getByText("配置排序字段", { exact: true }).click();
  await modal.getByRole("checkbox", { name: "序缇款号", exact: true }).check();
  await modal.getByRole("button", { name: "确定", exact: true }).click();
  await page.getByLabel("排序方式", { exact: true }).click();
  await page.getByText("序缇款号 ↓", { exact: true }).click();
  await expect(
    page.locator('td[data-selection-column="xutiStyleNo"]').first(),
  ).toContainText("STYLE-3");
  await page.reload();
  await page.getByLabel("分组方式", { exact: true }).click();
  await expect(
    page
      .locator(".ant-select-dropdown:visible")
      .getByText("按颜色分组", { exact: true }),
  ).toBeVisible();
});
test("new system fields use server identities and immutable numbering with configurable presentation", async ({
  page,
}) => {
  const addField = async (label: string, type: string) => {
    await page.getByRole("button", { name: "字段管理", exact: true }).click();
    await page.getByRole("button", { name: /添加字段$/ }).click();
    await page.getByLabel("字段名称", { exact: true }).fill(label);
    await page.getByLabel("字段类型", { exact: true }).fill(type);
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText(type, { exact: true })
      .click();
  };
  await addField("自动序号", "编号");
  await page.getByLabel("编号前缀").fill("X-");
  await page.getByLabel("编号位数").fill("4");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const header = page.getByRole("columnheader", {
    name: "选择整列：自动序号",
    exact: true,
  });
  await header.scrollIntoViewIfNeeded();
  const key = await header.getAttribute("data-selection-column");
  await expect(
    page.locator(`td[data-selection-column="${key}"]`).first(),
  ).toContainText("X-0001");
  await expect(
    page.locator(
      `td[data-selection-column="${key}"] input,td[data-selection-column="${key}"] textarea`,
    ),
  ).toHaveCount(0);
  await addField("记录创建人", "创建人");
  await page.getByLabel("人员显示方式").click();
  await page.getByText("姓名和账号", { exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const creator = page.getByRole("columnheader", {
    name: "选择整列：记录创建人",
    exact: true,
  });
  await creator.scrollIntoViewIfNeeded();
  const creatorKey = await creator.getAttribute("data-selection-column");
  await expect(
    page.locator(`td[data-selection-column="${creatorKey}"]`).first(),
  ).toContainText("管理员（admin）");
});
