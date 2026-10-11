import { expect, test, type Page } from "@playwright/test";
import {
  projectSelectionSharedLayout,
  selectionLayoutSchema,
} from "../../packages/contracts/src/selection-layout.js";

async function fixture(page: Page) {
  let preferences = selectionLayoutSchema.parse({
      columns: [
        { key: "vipPrice", label: "唯品价", width: 100, type: "currency" },
        { key: "material", label: "材质", width: 100, type: "text" },
        { key: "supplierCode", label: "供应商编码", width: 100, type: "text" },
      ],
      columnGroups: [
        { id: "price", name: "价格", columnKeys: ["vipPrice"] },
        { id: "quality", name: "质检", columnKeys: ["material"] },
        { id: "supplier", name: "供应商信息", columnKeys: ["supplierCode"] },
      ],
    }),
    revision = 1;
  const writes: Record<string, unknown>[] = [],
    row = {
      id: "1",
      xutiStyleNo: "GROUP-CARDS",
      vipPrice: 10,
      material: "棉",
      supplierCode: "S1",
      images: [],
      labelImages: [],
      extraFields: {},
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
        permissions: ["selection.read", "selection.manage"],
      };
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
        preferences = selectionLayoutSchema.parse(body.preferences);
        revision++;
      }
      data = {
        preferences,
        revision,
        sharedRevision: revision,
        sharedPreferences: projectSelectionSharedLayout(preferences),
        canEditShared: true,
      };
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(
    page.locator(".selection-column-group-tabs").getByRole("tab"),
  ).toHaveCount(4);
  return {
    writes,
    saved: () => preferences.columnGroups.map((group) => group.name),
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
