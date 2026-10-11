import { expect, test, type Page } from "@playwright/test";
import {
  projectSelectionSharedLayout,
  selectionLayoutSchema,
  applySelectionSharedLayout,
} from "../../packages/contracts/src/selection-layout.js";

async function fixture(page: Page, entryPath = "/style-selections", mixed = false, readonly = false) {
  let preferences = selectionLayoutSchema.parse({
      columns: [
        { key: "vipPrice", label: "唯品价", width: 100, type: "currency" },
        { key: "material", label: "材质", width: 100, type: "text" },
        { key: "supplierCode", label: "供应商编码", width: 100, type: "text" },
        ...(mixed ? [{ key: "custom:private-check", label: "本人核对", width: 100, type: "text", custom: true, ownerId: "101", visibility: "PRIVATE" }] : []),
      ],
      columnGroups: [
        { id: "price", name: "价格", columnKeys: ["vipPrice"] },
        { id: "quality", name: "质检", columnKeys: mixed ? ["material", "custom:private-check"] : ["material"] },
        { id: "supplier", name: "供应商信息", columnKeys: ["supplierCode"] },
      ],
    }),
    revision = 1;
  let sharedPreferences = projectSelectionSharedLayout(preferences);
  let rejectNext = false;
  const writes: Record<string, unknown>[] = [],
    row = {
      id: "1",
      xutiStyleNo: "GROUP-CARDS",
      vipPrice: 10,
      material: "棉",
      supplierCode: "S1",
      images: [],
      labelImages: [],
      extraFields: mixed ? { "custom:private-check": "本人的核对内容" } : {},
      updatedAt: "2026-10-11T00:00:00Z",
    };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me"))
      data = {
        id: "101",
        displayName: "分组顺序测试",
        csrfToken: "fixture",
        roleCodes: [],
        permissions: ["selection.read", "product.read", "project.read", ...(!readonly ? ["selection.manage", "product.manage", "project.create"] : [])],
      };
    if (path.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: true, canManage: true };
    if (path.endsWith("/project-tables/7")) data = { id: "7", name: "分组协作表", initialLayout: "selection", canEdit: true, canManage: true };
    if (path.endsWith("/revision")) data = { revision: "one" };
    if (path.endsWith("/sync"))
      data = {
        revision: "one",
        index: [{ id: "1", token: row.updatedAt }],
        data: [row],
      };
    if (path.endsWith("/shared-view"))
      data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        writes.push(body);
        if (rejectNext) {
          rejectNext = false;
          await route.fulfill({ status: 500, json: { error: { message: "分组设置保存失败，请重试" } } });
          return;
        }
        if (body.sharedChanges) sharedPreferences = projectSelectionSharedLayout({ ...sharedPreferences, ...body.sharedChanges });
        // Replay the actual API merge, which used to append all private groups
        // and undo a saved mixed-group move even when the drag draft was right.
        preferences = applySelectionSharedLayout(selectionLayoutSchema.parse(body.preferences), sharedPreferences);
        revision++;
      }
      data = {
        preferences,
        revision,
        sharedRevision: revision,
        sharedPreferences,
        canEditShared: !readonly,
      };
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(entryPath);
  await expect(
    page.locator(".selection-column-group-tabs").getByRole("tab"),
  ).toHaveCount(4);
  return {
    writes,
    saved: () => preferences.columnGroups.map((group) => group.name),
    rejectNextSave: () => { rejectNext = true; },
  };
}

test("字段分组卡片拖拽仅改草稿，保存后TAB和共享分组同序，取消保留原顺序", async ({
  page,
}) => {
  const state = await fixture(page),
    tabs = page.locator(".selection-column-group-tabs").getByRole("tab");
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "配置字段分组", exact: true });
  await panel
    .getByRole("button", { name: "拖动分组价格", exact: true })
    .dragTo(panel.locator('[data-column-group="supplier"]'));
  await expect(panel.getByLabel("分组名称1", { exact: true })).toHaveValue(
    "质检",
  );
  await expect(panel.getByLabel("分组名称3", { exact: true })).toHaveValue(
    "价格",
  );
  expect(state.writes).toHaveLength(0);
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(tabs).toHaveText(["全部字段", "价格", "质检", "供应商信息"]);
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  await expect(panel.getByLabel("分组名称1", { exact: true })).toHaveValue(
    "价格",
  );
  await panel
    .getByRole("button", { name: "拖动分组价格", exact: true })
    .dragTo(panel.locator('[data-column-group="supplier"]'));
  await panel
    .getByRole("button", { name: "上移分组价格", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "拖动分组价格", exact: true })
    .focus();
  await page.keyboard.press("ArrowDown");
  await expect(panel.getByLabel("分组名称3", { exact: true })).toHaveValue(
    "价格",
  );
  await panel.getByRole("button", { name: "保存分组", exact: true }).click();
  await expect(tabs).toHaveText(["全部字段", "质检", "供应商信息", "价格"]);
  await expect.poll(state.saved).toEqual(["质检", "供应商信息", "价格"]);
  expect(state.writes.at(-1)?.sharedChanges).toMatchObject({
    columnGroups: [{ id: "quality" }, { id: "supplier" }, { id: "price" }],
  });
  await page.reload();
  await expect(tabs).toHaveText(["全部字段", "质检", "供应商信息", "价格"]);
});

for (const [label, path] of [["选款登记", "/style-selections"], ["商品档案", "/products"], ["项目协作表格", "/project-tables/7"]]) {
  test(`${label}混合私有字段的质检分组与供应商分组调换后保存和刷新均保持位置`, async ({ page }) => {
    const state = await fixture(page, path, true), tabs = page.locator(".selection-column-group-tabs").getByRole("tab");
    await page.getByRole("button", { name: "字段分组", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "配置字段分组", exact: true });
    await panel.getByRole("button", { name: "拖动分组供应商信息", exact: true }).dragTo(panel.locator('[data-column-group="quality"]'));
    await expect(panel.getByLabel("分组名称2", { exact: true })).toHaveValue("供应商信息");
    await expect(panel.getByLabel("分组名称3", { exact: true })).toHaveValue("质检");
    await panel.getByRole("button", { name: "保存分组", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(state.saved).toEqual(["价格", "供应商信息", "质检"]);
    await expect(tabs).toHaveText(["全部字段", "价格", "供应商信息", "质检"]);
    expect(state.writes.at(-1)?.sharedChanges).toBeUndefined();
    expect(JSON.stringify(state.writes.at(-1)?.sharedChanges || {})).not.toContain("custom:private-check");
    await page.reload();
    await expect(tabs).toHaveText(["全部字段", "价格", "供应商信息", "质检"]);
    await page.getByRole("button", { name: "字段分组", exact: true }).click();
    await expect(panel.getByLabel("分组名称3", { exact: true })).toHaveValue("质检");
    await panel.getByRole("button", { name: "上移分组质检", exact: true }).click();
    await panel.getByRole("button", { name: "保存分组", exact: true }).click();
    await expect.poll(state.saved).toEqual(["价格", "质检", "供应商信息"]);
    await expect(panel).toHaveCount(0);
    await page.reload();
    await expect(tabs).toHaveText(["全部字段", "价格", "质检", "供应商信息"]);
  });
}

test("分组保存失败时窗口保留调序草稿，可重试保存并在刷新后恢复", async ({ page }) => {
  const state = await fixture(page, "/style-selections", true);
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "配置字段分组", exact: true });
  await panel.getByRole("button", { name: "下移分组质检", exact: true }).click();
  state.rejectNextSave();
  await panel.getByRole("button", { name: "保存分组", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("本次草稿已保留");
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("分组名称3", { exact: true })).toHaveValue("质检");
  expect(state.saved()).toEqual(["价格", "质检", "供应商信息"]);
  await expect(panel.getByRole("button", { name: "保存分组", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "保存分组", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(state.saved).toEqual(["价格", "供应商信息", "质检"]);
  await page.reload();
  await expect(page.locator(".selection-column-group-tabs").getByRole("tab")).toHaveText(["全部字段", "价格", "供应商信息", "质检"]);
});

test("只读用户修改公开分组顺序明确保留草稿，移动本人私有分组仍可保存", async ({ page }) => {
  const state = await fixture(page, "/style-selections", true, true);
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "配置字段分组", exact: true });
  await panel.getByRole("button", { name: "上移分组供应商信息", exact: true }).click();
  await panel.getByRole("button", { name: "上移分组供应商信息", exact: true }).click();
  await panel.getByRole("button", { name: "保存分组", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("需要表格编辑权限");
  await expect(panel).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await panel.getByRole("button", { name: "下移分组供应商信息", exact: true }).click();
  await expect(panel.getByLabel("分组名称3", { exact: true })).toHaveValue("质检");
  await panel.getByRole("button", { name: "保存分组", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(state.saved).toEqual(["价格", "供应商信息", "质检"]);
  expect(state.writes.at(-1)?.sharedChanges).toBeUndefined();
  await page.reload();
  await expect(page.locator(".selection-column-group-tabs").getByRole("tab")).toHaveText(["全部字段", "价格", "供应商信息", "质检"]);
});
