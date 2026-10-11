import { expect, test, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

async function fixture(page: Page, entry: string, pinned = false) {
  let preferences = selectionLayoutSchema.parse({
    columns: [
      { key: "xutiStyleNo", label: "序缇款号", width: 140, type: "text" },
      ...Array.from({ length: 22 }, (_, index) => ({ key: `custom:${index}`, label: index === 17 ? "长标题" : `字段${index + 1}`, width: 120, type: "text", custom: true, visibility: "PUBLIC" })),
    ],
    fixedColumns: pinned ? ["xutiStyleNo"] : [],
    columnGroups: [{ id: "titles", name: "标题", columnKeys: ["custom:17", "custom:18"] }],
  });
  let sharedPreferences = projectSelectionSharedLayout(preferences), revision = 1;
  const writes: Record<string, unknown>[] = [];
  const rows = Array.from({ length: 20 }, (_, index) => ({
    id: String(index + 1), xutiStyleNo: `RESIZE-${index + 1}`, sortOrder: index,
    images: [], labelImages: [], extraFields: { "custom:17": "保留查看位置" },
    updatedAt: "2026-10-11T00:00:00Z",
  }));
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "列宽测试", csrfToken: "fixture", roleCodes: ["SUPER_ADMIN"], permissions: ["selection.read", "selection.manage", "product.read", "product.manage", "project.read", "project.create"] };
    if (path.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: true, canManage: true };
    if (path.endsWith("/project-tables/7")) data = { id: "7", name: "列宽协作表", initialLayout: "selection", canEdit: true, canManage: true };
    if (path.endsWith("/revision")) data = { revision: "rows" };
    if (path.endsWith("/sync")) data = { revision: "rows", index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        writes.push(body);
        preferences = selectionLayoutSchema.parse(body.preferences);
        if (body.sharedChanges) sharedPreferences = { ...sharedPreferences, ...body.sharedChanges };
        revision++;
      }
      data = { preferences, revision, sharedPreferences, sharedRevision: revision, canEditShared: true };
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(entry);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(20);
  return { writes, width: () => preferences.columns.find(column => column.key === "custom:17")!.width };
}

for (const [label, entry] of [["选款登记", "/style-selections"], ["商品档案", "/products"], ["项目协作表格", "/project-tables/7"]]) {
  test(`${label}：右侧列宽拖拽及共享保存后保持横纵滚动位置`, async ({ page }) => {
    const state = await fixture(page, entry, entry === "/project-tables/7"), sheet = page.locator(".selection-sheet");
    const scroll = () => sheet.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }));
    const target = page.locator('th[data-selection-column="custom:17"]');
    await sheet.evaluate(element => {
      const header = element.querySelector<HTMLElement>('th[data-selection-column="custom:17"]')!;
      element.scrollLeft = header.offsetLeft - 620;
      element.scrollTop = 420;
    });
    const before = await scroll();
    expect(before.left).toBeGreaterThan(1000);
    const handle = await target.locator(".selection-column-resize").boundingBox();
    expect(handle).not.toBeNull();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x + handle!.width / 2 + 40, handle!.y + handle!.height / 2, { steps: 4 });
    await expect(target).toHaveCSS("width", "160px");
    expect(await scroll()).toEqual(before);
    await page.mouse.move(handle!.x + handle!.width / 2 + 20, handle!.y + handle!.height / 2, { steps: 2 });
    await expect(target).toHaveCSS("width", "140px");
    expect(await scroll()).toEqual(before);
    await page.mouse.up();
    await expect.poll(state.width).toBe(140);
    expect(state.writes.at(-1)?.sharedChanges).toMatchObject({ columns: expect.arrayContaining([expect.objectContaining({ key: "custom:17", width: 140 })]) });
    expect(await scroll()).toEqual(before);

    // Explicitly switching a field group still performs the documented locating
    // action. The fix must only remove width changes from that trigger.
    await page.getByRole("tab", { name: "标题", exact: true }).click();
    await expect.poll(() => sheet.evaluate(element => element.scrollLeft)).not.toBe(before.left);
    expect((await scroll()).top).toBe(before.top);
  });
}
