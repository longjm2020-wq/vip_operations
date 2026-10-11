import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, path: string) {
  let preferences: Record<string, unknown> = {
      columns: [
        { key: "xutiStyleNo", label: "序缇款号", width: 224, type: "text" },
        {
          key: "custom:unset",
          label: "未设置宽度",
          custom: true,
          type: "text",
        },
      ],
      rowHeight: "extra",
    },
    revision = 1;
  const row = {
    id: "1",
    xutiStyleNo: "DIMENSION-1",
    sortOrder: 1,
    images: [],
    labelImages: [],
    extraFields: { "custom:unset": "测试" },
    updatedAt: "2026-10-11T00:00:00Z",
  };
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      apiPath = url.pathname;
    let data: unknown = [];
    if (apiPath.endsWith("/auth/me"))
      data = {
        id: "101",
        displayName: "尺寸测试",
        roleCodes: ["SUPER_ADMIN"],
        permissions: [
          "selection.read",
          "selection.manage",
          "product.read",
          "product.manage",
          "project.read",
          "project.create",
        ],
        csrfToken: "test",
      };
    if (apiPath.endsWith("/product-archive-table"))
      data = {
        id: "3",
        initialLayout: "selection",
        fields: [],
        references: {},
        canEdit: true,
        canManage: true,
      };
    if (apiPath.endsWith("/project-tables/7"))
      data = {
        id: "7",
        name: "测试协作表",
        initialLayout: "selection",
        canEdit: true,
        canManage: true,
      };
    if (apiPath.endsWith("/layout-preferences")) {
      if (route.request().method() === "POST") {
        preferences = route.request().postDataJSON().preferences;
        revision++;
      }
      data = {
        preferences,
        revision,
        sharedRevision: 0,
        sharedPreferences: null,
        canEditShared: true,
      };
    }
    if (apiPath.endsWith("/revision")) data = { revision: "one" };
    if (apiPath.endsWith("/sync"))
      data = {
        revision: "one",
        index: [{ id: "1", token: row.updatedAt }],
        data: [row],
      };
    if (apiPath.endsWith("/shared-view"))
      data = { revision: 0, view: { filters: {}, sort: null } };
    await route.fulfill({ json: { data } });
  });
  await page.goto(path);
  await expect(
    page.locator('td[data-selection-column="xutiStyleNo"]').first(),
  ).toBeVisible();
}

for (const [label, path] of [
  ["选款登记", "/style-selections"],
  ["商品档案", "/products"],
  ["项目协作表格", "/project-tables/7"],
]) {
  test(`${label}：宽松100px，新列100px，已保存列宽与表头高度保留`, async ({
    page,
  }) => {
    await fixture(page, path);
    const oldHeader = page.locator(
        'thead th[data-selection-column="xutiStyleNo"]',
      ),
      unsetHeader = page.locator(
        'thead th[data-selection-column="custom:unset"]',
      ),
      cell = page.locator('td[data-selection-column="xutiStyleNo"]').first(),
      headerHeight = (await oldHeader.boundingBox())!.height;
    await expect(oldHeader).toHaveCSS("width", "224px");
    await expect(unsetHeader).toHaveCSS("width", "100px");
    await page.locator(".selection-tool-select").nth(2).click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText("宽松行高", { exact: true })
      .click();
    await expect(cell).toHaveCSS("height", "100px");
    expect((await oldHeader.boundingBox())!.height).toBe(headerHeight);
    await page.getByRole("button", { name: "字段管理", exact: true }).click();
    await page.getByRole("button", { name: "添加字段", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "添加字段", exact: true });
    await dialog.getByLabel("字段名称", { exact: true }).fill("新增100列");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.getByRole("columnheader").filter({ hasText: "新增100列" }),
    ).toHaveCSS("width", "100px");
    await expect(oldHeader).toHaveCSS("width", "224px");
    await page.reload();
    await expect(cell).toHaveCSS("height", "100px");
    await expect(oldHeader).toHaveCSS("width", "224px");
    await expect(
      page.getByRole("columnheader").filter({ hasText: "新增100列" }),
    ).toHaveCSS("width", "100px");
  });
}
