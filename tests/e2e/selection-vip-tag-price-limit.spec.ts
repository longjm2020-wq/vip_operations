import { expect, test, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { defaultVipTagPriceLimitRules } from "../../packages/contracts/src/selection-vip-tag-price-limit.js";

const sourceKey = "custom:category", limitKey = "custom:vip-limit";
async function fixture(page: Page, path = "/style-selections", computed = true) {
  let revision = 1, dataRevision = 0;
  let preferences = selectionLayoutSchema.parse({ columns: [
    { key: "xutiStyleNo", label: "序缇款号", width: 150, type: "text" },
    { key: sourceKey, label: "三级类目", width: 190, custom: true, type: "text", ownerId: "101", visibility: "PUBLIC" },
    ...(computed ? [{ key: limitKey, label: "唯品吊牌限价", width: 190, custom: true, type: "vipTagPriceLimit", ownerId: "101", visibility: "PUBLIC", vipTagPriceLimitConfig: { sourceKey, rules: defaultVipTagPriceLimitRules } }] : []),
  ], rowHeight: "normal" });
  const records = ["半截裙", "连衣裙", "尚未配置类目", "半截裙"].map((category, index) => ({
    id: String(index + 1), xutiStyleNo: `VIP-LIMIT-${index + 1}`, sortOrder: index + 1,
    images: [], labelImages: [], extraFields: { [sourceKey]: category, [limitKey]: "8888" },
    cellAccess: { xutiStyleNo: "edit", [sourceKey]: index === 3 ? "deny" : "edit", [limitKey]: "edit" },
    hiddenCells: index === 3 ? [sourceKey] : [], updatedAt: "2026-10-16T00:00:00.000Z",
  }));
  const patches: Record<string, any>[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), apiPath = new URL(request.url()).pathname;
    let data: unknown = [];
    if (apiPath.endsWith("/auth/me")) data = { id: "101", displayName: "限价测试", roleCodes: ["SUPER_ADMIN"], csrfToken: "fixture", permissions: ["selection.read", "selection.manage", "product.read", "product.manage", "project.read", "project.create"] };
    if (apiPath.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: true, canManage: true };
    if (apiPath.endsWith("/project-tables/7")) data = { id: "7", name: "限价协作表", initialLayout: "selection", canEdit: true, canManage: true };
    if (apiPath.endsWith("/revision")) data = { revision: `limit-${dataRevision}` };
    if (apiPath.endsWith("/sync")) data = { revision: `limit-${dataRevision}`, index: records.map(row => ({ id: row.id, token: row.updatedAt })), data: records };
    if (apiPath.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (apiPath.endsWith("/layout-preferences")) {
      if (request.method() === "POST") { preferences = selectionLayoutSchema.parse(request.postDataJSON().preferences); revision++; }
      data = { preferences, revision, sharedRevision: revision, sharedPreferences: projectSelectionSharedLayout(preferences), canEditShared: true };
    }
    const row = records.find(record => apiPath.endsWith(`/style-selections/${record.id}`));
    if (row && request.method() === "PATCH") {
      const body = request.postDataJSON(); patches.push(body);
      Object.assign(row, body, { extraFields: { ...row.extraFields, ...body.extraFields }, updatedAt: new Date(Date.UTC(2026, 9, 16) + ++dataRevision).toISOString() });
      data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(path);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(4);
  return { patches, records, preferences: () => preferences };
}
const cell = (page: Page, id: string, key = limitKey) => page.locator(`td[data-selection-row="${id}"][data-selection-column="${key}"]`);

for (const [label, path] of [["选款登记", "/style-selections"], ["商品档案", "/products"], ["项目协作表格", "/project-tables/7"]]) {
  test(`${label}限价跟随类目更新，复制计算值且不写入计算字段`, async ({ page, context }) => {
    const state = await fixture(page, path);
    await expect(cell(page, "1")).toHaveText("899");
    await expect(cell(page, "2")).toHaveText("2799");
    await expect(cell(page, "3")).toHaveText("");
    await expect(cell(page, "4")).toHaveText("");
    expect(state.patches).toHaveLength(0);
    const source = cell(page, "1", sourceKey).getByLabel("三级类目", { exact: true });
    await source.dblclick();
    await source.fill("连衣裙");
    await expect(cell(page, "1")).toHaveText("2799");
    await expect.poll(() => state.patches.length).toBe(1);
    expect(state.patches[0].extraFields).toEqual({ [sourceKey]: "连衣裙" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await cell(page, "1").click();
    await cell(page, "1").press("Control+c");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("2799");
    await expect(page.getByRole("group", { name: "单元格编辑栏" }).getByLabel("唯品吊牌限价", { exact: true })).toHaveAttribute("readonly", "");
    await cell(page, "1").press("Delete");
    await expect(cell(page, "1")).toHaveText("2799");
    await page.reload();
    await expect(cell(page, "1")).toHaveText("2799");
    expect(state.records[0].extraFields[limitKey]).toBe("8888");
  });
}

test("新增限价字段预填规则，支持未来新类目并校验重复与空金额，取消不改规则", async ({ page }) => {
  const state = await fixture(page, "/products", false);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "添加字段", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加字段", exact: true });
  await dialog.getByLabel("字段名称", { exact: true }).fill("唯品吊牌限价");
  await dialog.getByRole("combobox", { name: "字段类型", exact: true }).click();
  await dialog.getByRole("combobox", { name: "字段类型", exact: true }).fill("唯品吊牌限价");
  await page.locator(".ant-select-dropdown:visible").getByText("唯品吊牌限价", { exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "三级类目来源字段", exact: true })).toBeVisible();
  await expect(dialog.getByRole("table", { name: "吊牌限价匹配规则" }).locator("tbody tr")).toHaveCount(18);
  await expect(dialog.getByRole("spinbutton", { name: "第1条吊牌限价", exact: true })).toHaveValue("899");
  await dialog.getByRole("button", { name: "新增三级类目规则", exact: true }).click();
  await dialog.getByLabel("第19条三级类目", { exact: true }).fill(" 半截裙 ");
  await dialog.getByRole("spinbutton", { name: "第19条吊牌限价", exact: true }).fill("499.99");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(/第19条规则的三级类目.*已存在/)).toBeVisible();
  await dialog.getByLabel("第19条三级类目", { exact: true }).fill("尚未配置类目");
  await dialog.getByRole("spinbutton", { name: "第19条吊牌限价", exact: true }).fill("");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(/第19条规则的吊牌限价须为/)).toBeVisible();
  await dialog.getByRole("spinbutton", { name: "第19条吊牌限价", exact: true }).fill("499.99");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.preferences().columns.find(field => field.type === "vipTagPriceLimit")?.vipTagPriceLimitConfig?.rules.length).toBe(19);
  const savedField = state.preferences().columns.find(field => field.type === "vipTagPriceLimit")!;
  expect(savedField.vipTagPriceLimitConfig?.sourceKey).toBe(sourceKey);
  await expect(cell(page, "1", savedField.key)).toHaveText("899");
  await expect(cell(page, "3", savedField.key)).toHaveText("499.99");
  await page.reload();
  await expect(cell(page, "3", savedField.key)).toHaveText("499.99");
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "编辑字段唯品吊牌限价", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑字段", exact: true });
  await edit.getByRole("spinbutton", { name: "第1条吊牌限价", exact: true }).fill("1");
  await edit.getByRole("button", { name: "取消", exact: true }).click();
  await expect(cell(page, "1", savedField.key)).toHaveText("899");
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "编辑字段唯品吊牌限价", exact: true }).click();
  await edit.getByRole("button", { name: "删除第19条限价规则", exact: true }).click();
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await expect(cell(page, "3", savedField.key)).toHaveText("");
  expect(state.patches).toHaveLength(0);
});
