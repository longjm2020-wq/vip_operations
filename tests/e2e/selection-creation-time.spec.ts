import { expect, test, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

async function fixture(page: Page, entry: string) {
  const legacyColumns = [
    { key: "registrationBatch", label: "登记批次", width: 180, type: entry === "/products" ? "text" : "date" },
    { key: "xutiStyleNo", label: "序缇款号", width: 140, type: "text" },
    { key: "material", label: "材质", width: 140, type: "text" },
  ];
  // Return a persisted old personal AND shared layout. The application's actual
  // snapshot parser must upgrade it, rather than the fixture pre-upgrading it.
  let preferences = { ...selectionLayoutSchema.parse({ columns: [] }), columns: legacyColumns };
  let sharedPreferences = { ...projectSelectionSharedLayout(selectionLayoutSchema.parse(preferences)), columns: legacyColumns };
  let revision = 1, dataRevision = 0;
  const rows = [1, 2].map(id => ({
    id: String(id), xutiStyleNo: `CREATED-${id}`, registrationBatch: "2026-09-28", material: "棉",
    sortOrder: id, images: [], labelImages: [], extraFields: {},
    createdAt: id === 1 ? "2026-10-01T00:01:02Z" : "2026-10-03T02:03:04Z",
    updatedAt: "2026-10-11T00:00:00Z",
  }));
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "创建时间测试", csrfToken: "fixture", roleCodes: ["SUPER_ADMIN"], permissions: ["selection.read", "selection.manage", "product.read", "product.manage"] };
    if (path.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: legacyColumns, references: {}, canEdit: true, canManage: true };
    if (path.endsWith("/revision")) data = { revision: `created-${dataRevision}` };
    if (path.endsWith("/sync")) data = { revision: `created-${dataRevision}`, index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        preferences = body.preferences;
        if (body.sharedChanges) sharedPreferences = { ...sharedPreferences, ...body.sharedChanges };
        revision++;
      }
      data = { preferences, revision, sharedPreferences, sharedRevision: revision, canEditShared: true };
    }
    const row = rows.find(item => path.endsWith(`/style-selections/${item.id}`));
    if (row && request.method() === "PATCH") {
      const body = request.postDataJSON();
      writes.push(body);
      Object.assign(row, body, { updatedAt: new Date(Date.UTC(2026, 9, 11) + ++dataRevision).toISOString() });
      data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(entry);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(2);
  return { rows, writes, display: () => selectionLayoutSchema.parse(preferences).columns.find(field => field.key === "registrationBatch")?.timeDisplay };
}

test("选款登记和商品档案升级旧批次布局为真实创建时间，只读且筛选、保存和刷新一致", async ({ page }) => {
  for (const entry of ["/style-selections", "/products"]) {
    await page.unroute("**/api/v1/**");
    const state = await fixture(page, entry);
    const createdCell = page.locator('td[data-selection-row="1"][data-selection-column="registrationBatch"]');
    await expect(page.getByRole("columnheader", { name: "选择整列：创建时间", exact: true })).toBeVisible();
    await expect(createdCell).toHaveText("2026-10-01 08:01:02");
    await expect(createdCell.locator("input,textarea")).toHaveCount(0);
    await createdCell.click();
    const editor = page.getByRole("group", { name: "单元格编辑栏", exact: true }).getByRole("textbox", { name: "创建时间", exact: true });
    await expect(editor).toHaveAttribute("readonly", "");
    await expect(editor).toHaveValue("2026-10-01 08:01:02");
    await createdCell.evaluate(element => {
      const transfer = new DataTransfer(); transfer.setData("text/plain", "2000-01-01");
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await page.keyboard.press("Delete");
    await expect(createdCell).toHaveText("2026-10-01 08:01:02");
    const material = page.locator('td[data-selection-row="1"][data-selection-column="material"]').getByRole("textbox", { name: "材质", exact: true });
    await material.fill("羊毛");
    await expect.poll(() => state.rows[0].material).toBe("羊毛");
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).not.toHaveProperty("registrationBatch");
    expect(state.writes[0]).not.toHaveProperty("createdAt");
    expect(state.rows[0].registrationBatch).toBe("2026-09-28");
    expect(state.rows[0].createdAt).toBe("2026-10-01T00:01:02Z");
    await expect(createdCell).toHaveText("2026-10-01 08:01:02");

    await page.getByRole("button", { name: "筛选创建时间", exact: true }).click();
    const filter = page.locator(".selection-filter-panel:visible");
    await expect(filter.locator(".selection-filter-values")).toContainText("2026-10-01 08:01:02");
    await expect(filter.locator(".selection-filter-values")).not.toContainText("2026-09-28");
    await filter.getByRole("textbox", { name: "搜索筛选选项", exact: true }).fill("2026-10-01");
    await filter.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
    await page.reload();
    await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
    await expect(createdCell).toHaveText("2026-10-01 08:01:02");
    await page.getByRole("button", { name: "筛选创建时间", exact: true }).click();
    await page.locator(".selection-filter-panel:visible").getByRole("button", { name: "清除筛选", exact: true }).click();
    await expect(page.locator("tr[data-selection-row]")).toHaveCount(2);
    await page.getByRole("textbox", { name: "搜索选款", exact: true }).fill("2026-10-03");
    await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
    await expect(page.locator('td[data-selection-row="2"][data-selection-column="registrationBatch"]')).toHaveText("2026-10-03 10:03:04");
    await page.getByRole("textbox", { name: "搜索选款", exact: true }).fill("");
    await expect(page.locator("tr[data-selection-row]")).toHaveCount(2);

    await page.getByRole("button", { name: "字段管理", exact: true }).click();
    await page.getByRole("button", { name: "编辑字段创建时间", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "编辑字段", exact: true });
    await settings.getByRole("combobox", { name: "字段类型", exact: true }).click();
    await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-option-content")).toHaveText(["创建时间"]);
    await page.keyboard.press("Escape");
    await settings.getByRole("combobox", { name: "时间显示格式", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible").getByText("日期 YYYY-MM-DD", { exact: true }).click();
    await settings.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(state.display).toBe("date");
    await page.reload();
    await expect(createdCell).toHaveText("2026-10-01");
    expect(state.rows[0].registrationBatch).toBe("2026-09-28");
    expect(state.rows[0].createdAt).toBe("2026-10-01T00:01:02Z");
  }
});
