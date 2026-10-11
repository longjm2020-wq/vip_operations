import { expect, test, type Page } from "@playwright/test";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

async function fixture(page: Page) {
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    id: String(index + 1), xutiStyleNo: `SMOOTH-${index + 1}`, material: `第 ${index + 1} 款：100% 棉质`,
    sortOrder: index + 1, images: [], labelImages: [], extraFields: {},
    updatedAt: "2026-10-11T00:00:00Z", defaultCellAccess: "edit", cellAccess: {},
  }));
  const preferences = selectionLayoutSchema.parse({ columns: [
    { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 140 },
    { key: "material", label: "成分", type: "text", width: 200 },
  ], rowHeight: "loose", pageSize: 1000 });
  let writes = 0;
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "拖选测试", csrfToken: "fixture", roleCodes: [], permissions: ["selection.read", "selection.manage"] };
    if (path.endsWith("/revision")) data = { revision: "1" };
    if (path.endsWith("/sync")) data = { revision: "1", index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/style-counts")) data = rows.map(row => ({ xutiStyleNo: row.xutiStyleNo, count: 1 }));
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) data = { preferences, revision: 1, sharedPreferences: null, sharedRevision: 0, canEditShared: true };
    if (request.method() === "PATCH") writes++;
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  const sheet = page.locator(".selection-sheet"), first = page.locator('td[data-selection-row="1"][data-selection-column="material"]');
  await expect(first).toBeVisible(); await expect(sheet).toHaveAttribute("data-windowed", "true");
  return { sheet, first, editor: first.getByLabel("成分", { exact: true }), writes: () => writes };
}

test("already highlighted cell text drags into a virtual rectangle and stationary edge scroll stops on release", async ({ page }) => {
  const { sheet, first, editor, writes } = await fixture(page);
  await editor.click(); await expect(first).toHaveClass(/selection-cell-active/);
  await editor.evaluate(element => { const input = element as HTMLTextAreaElement; input.setSelectionRange(0, input.value.length); });
  let preventedDrag = false;
  await page.exposeFunction("dragStartResult", (prevented: boolean) => { preventedDrag = prevented; });
  await page.evaluate(() => document.addEventListener("dragstart", event => {
    queueMicrotask(() => { void (window as unknown as { dragStartResult: (prevented: boolean) => Promise<void> }).dragStartResult(event.defaultPrevented); });
  }));
  const start = (await editor.boundingBox())!, bounds = (await sheet.boundingBox())!;
  const x = start.x + start.width / 2, y = start.y + start.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 8, y, { steps: 4 });
  // Browser-generated text drag, if emitted, must not enter HTML drag/drop mode.
  await editor.dispatchEvent("dragstart", { bubbles: true, cancelable: true });
  await expect.poll(() => preventedDrag).toBe(true);
  await page.mouse.move(x, start.y + start.height + 55, { steps: 8 });
  await expect(sheet).toHaveClass(/selection-dragging/);
  await expect(page.locator('td[data-selection-row="2"][data-selection-column="material"]')).toHaveClass(/selection-cell-active/);
  await page.mouse.move(x, bounds.y + bounds.height - 3, { steps: 10 });
  await expect.poll(() => sheet.evaluate(element => element.scrollTop)).toBeGreaterThan(1800);
  await page.mouse.up(); await expect(sheet).not.toHaveClass(/selection-dragging/);
  const stopped = await sheet.evaluate(element => element.scrollTop);
  await expect.poll(async () => {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    return sheet.evaluate(element => element.scrollTop);
  }).toBe(stopped);
  const copied = await sheet.locator("table").evaluate(element => {
    const clipboard = new DataTransfer(); element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    return clipboard.getData("text/plain");
  });
  const lines = copied.split(/\r?\n/).filter(Boolean);
  expect(lines.length).toBeGreaterThan(20); expect(lines[0]).toBe("第 1 款：100% 棉质");
  for (const [index, line] of lines.entries()) expect(line).toBe(`第 ${index + 1} 款：100% 棉质`);
  expect(await sheet.locator('tr[data-selection-row]').count()).toBeLessThan(40);
  expect(writes()).toBe(0);
});

test("text highlighting inside one cell stays native; holding a plain click at the edge never scrolls", async ({ page }) => {
  const { sheet, first, editor, writes } = await fixture(page);
  await editor.click();
  const start = (await editor.boundingBox())!;
  await page.mouse.move(start.x + 55, start.y + start.height / 2);
  await page.mouse.down(); await page.mouse.move(start.x + start.width - 15, start.y + start.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await editor.evaluate(element => { const input = element as HTMLTextAreaElement; return input.selectionEnd - input.selectionStart; })).toBeGreaterThan(0);
  await expect(sheet).not.toHaveClass(/selection-dragging/);
  expect(await sheet.locator("td.selection-cell-active").count()).toBe(1);
  await expect(first).toHaveClass(/selection-cell-active/);
  const bounds = (await sheet.boundingBox())!, before = await sheet.evaluate(element => element.scrollTop);
  const cells = await page.locator('td[data-selection-column="xutiStyleNo"]').all();
  let point: { x: number; y: number } | undefined;
  for (const cell of cells) {
    const box = await cell.boundingBox();
    if (box && box.y < bounds.y + bounds.height - 4 && box.y + box.height > bounds.y + bounds.height - 4) point = { x: box.x + 30, y: bounds.y + bounds.height - 4 };
  }
  expect(point).toBeDefined();
  await page.mouse.move(point!.x, point!.y); await page.mouse.down();
  for (let frame = 0; frame < 8; frame++) await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  expect(await sheet.evaluate(element => element.scrollTop)).toBe(before);
  await page.mouse.up(); await expect(sheet).not.toHaveClass(/selection-dragging/);
  expect(writes()).toBe(0);
});
