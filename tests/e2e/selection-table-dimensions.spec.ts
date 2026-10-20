import { expect, test, type Page } from "@playwright/test";

const material = "面料：100%桑蚕丝\n里料：100%桑蚕丝\n配料：水貂毛皮\n填充物：100%桑蚕丝棉\n（饰品辅料织金除外）";
const longText = Array.from({ length: 12 }, (_, index) => `第${index + 1}行：保留完整说明`).join("\n");

async function fixture(page: Page, path: string, readonly = false) {
  let preferences: Record<string, unknown> = {
      columns: [
        { key: "xutiStyleNo", label: "序缇款号", width: 224, type: "text" },
        {
          key: "custom:unset",
          label: "未设置宽度",
          custom: true,
          type: "text",
        },
        { key: "material", label: "成分", width: 260, type: "text" },
        { key: "custom:notes", label: "多行备注", width: 250, custom: true, type: "text" },
        { key: "custom:legacy", label: "原文本", width: 160, custom: true, fallbackType: "text" },
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
    material,
    extraFields: { "custom:unset": "测试", "custom:notes": longText, "custom:legacy": longText },
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
          "product.read",
          "project.read",
          ...(!readonly ? ["selection.manage", "product.manage", "project.create"] : []),
        ],
        csrfToken: "test",
      };
    if (apiPath.endsWith("/product-archive-table"))
      data = {
        id: "3",
        initialLayout: "selection",
        fields: [],
        references: {},
        canEdit: !readonly,
        canManage: !readonly,
      };
    if (apiPath.endsWith("/project-tables/7"))
      data = {
        id: "7",
        name: "测试协作表",
        initialLayout: "selection",
        canEdit: !readonly,
        canManage: !readonly,
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

  test(`${label}：超宽行高完整展示五行成分，短文本保持垂直居中`, async ({ page }) => {
    await fixture(page, path);
    const cell = page.locator('td[data-selection-column="material"]');
    const text = cell.getByLabel("成分", { exact: true });
    await expect(text).toHaveValue(material);
    await expect.poll(() => text.evaluate(element => element.clientHeight)).toBeGreaterThan(100);
    expect(await text.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await expect(cell).toHaveCSS("height", "120px");
    const shortCell = page.locator('td[data-selection-column="custom:unset"]');
    const shortBounds = (await shortCell.getByLabel("未设置宽度").boundingBox())!;
    const cellBounds = (await shortCell.boundingBox())!;
    expect(shortBounds.height).toBeLessThan(40);
    expect(Math.abs(shortBounds.y + shortBounds.height / 2 - cellBounds.y - cellBounds.height / 2)).toBeLessThan(2);
    // Opening the compact editor must not push the table header down.
    const header = page.locator("thead");
    const headerTop = (await header.boundingBox())!.y;
    await text.click();
    await expect(page.locator(".selection-editor-control textarea")).toHaveCSS("height", "34px");
    expect((await header.boundingBox())!.y).toBe(headerTop);
  });
}

test("长文本使用各档行高的可用空间，格内滚动不撑高数据行", async ({ page }) => {
  await fixture(page, "/style-selections");
  const cell = page.locator('td[data-selection-column="custom:notes"]');
  const text = cell.getByLabel("多行备注");
  for (const [label, height] of [["紧凑行高", 40], ["标准行高", 50], ["宽松行高", 100], ["超宽行高", 120]] as const) {
    await page.locator(".selection-tool-select").nth(2).click();
    await page.locator(".ant-select-dropdown:visible").getByText(label, { exact: true }).click();
    await expect(cell).toHaveCSS("height", `${height}px`);
    await expect.poll(() => text.evaluate(element => element.clientHeight)).toBe(height - 1);
    expect(await text.evaluate(element => element.scrollHeight)).toBeGreaterThan(height);
    await text.hover();
    await page.mouse.wheel(0, 80);
    await expect.poll(() => text.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(cell).toHaveCSS("height", `${height}px`);
    await expect(text).toHaveValue(longText);
  }
  const legacy = page.locator('td[data-selection-column="custom:legacy"] textarea');
  await legacy.hover();
  await page.mouse.wheel(0, 80);
  await expect.poll(() => legacy.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});

test("只读文本也能利用完整行高并滚动查看，不产生写入", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", request => {
    if (request.method() === "PATCH") writes.push(request.url());
  });
  await fixture(page, "/products", true);
  const text = page.locator('td[data-selection-column="material"] textarea');
  await expect(text).toBeDisabled();
  await expect.poll(() => text.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  const long = page.locator('td[data-selection-column="custom:notes"] textarea');
  await expect(long).toBeDisabled();
  await long.hover();
  await page.mouse.wheel(0, 100);
  await expect.poll(() => long.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(writes).toEqual([]);
});
