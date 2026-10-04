import { expect, test, type Locator, type Page } from "@playwright/test";

const imageUrls = ["/api/v1/style-selections/images/preview-a", "/api/v1/style-selections/images/preview-b"];
async function fixture(page: Page, readonly = false, choiceFields = false, rowCount = 26) {
  const images = imageUrls.map((url, index) => ({ id: `image-${index}`, url, color: "" }));
  const rows: Record<string, any>[] = Array.from({ length: rowCount }, (_, index) => ({
    id: `shortcut-${index}`, sortOrder: index, updatedAt: "2026-10-04T00:00:00Z",
    xutiStyleNo: index === 5 || (index >= 15 && index < 20) ? "" : `SHORTCUT-${index}`,
    supplierStyleNo: index === 3 ? "Supplier words" : "",
    material: index === 3 ? "Cotton" : "",
    vipPrice: index === 17 ? "0" : null,
    images: index === 0 || index === 3 ? images : [],
    labelImages: index === 0 ? images : [],
    extraFields: { "custom:photos": "[]", ...(choiceFields ? { "custom:check": index === 1 ? "规范" : "", "custom:action": index === 2 ? "换洗唛/缝领标" : "" } : {}) },
  }));
  let revision = 0;
  await page.addInitScript(includeChoices => {
    localStorage.setItem("selection-field-types-initialized-v2", "1");
    if (!localStorage.getItem("style-selection-custom-columns-v1")) localStorage.setItem("style-selection-custom-columns-v1", JSON.stringify([
      { key: "custom:photos", label: "细节图", width: 120, custom: true, type: "image" },
      ...(includeChoices ? [
        { key: "custom:check", label: "洗涤标志核对", width: 120, custom: true, type: "single", options: ["规范", "不规范"] },
        { key: "custom:action", label: "衣服整改措施", width: 120, custom: true, type: "multiple", options: ["换洗唛", "缝领标", "查二次车缝"] },
      ] : []),
    ]));
  }, choiceFields);
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = {
      id: "interaction-tester", displayName: "交互测试", roleCodes: [], csrfToken: "fixture",
      permissions: readonly ? ["selection.read"] : ["selection.read", "selection.manage"],
    };
    if (path.endsWith("/revision")) data = { revision: `interactions-${revision}` };
    if (path.endsWith("/sync")) data = {
      revision: `interactions-${revision}`, index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows,
    };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    const row = rows.find(row => path.endsWith(`/style-selections/${row.id}`));
    if (row && route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON();
      Object.assign(row, patch, { extraFields: { ...row.extraFields, ...patch.extraFields }, updatedAt: new Date(1791072000000 + ++revision).toISOString() });
      data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.route("**/api/v1/style-selections/images/preview-*", route => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#e9dccd"/><rect x="90" y="180" width="420" height="480" fill="#fffaf5"/><text x="175" y="435" font-size="38">Image preview</text></svg>',
  }));
  await page.goto("/style-selections");
  await expect(page.locator('td[data-selection-column="xutiStyleNo"]')).toHaveCount(20);
}
const cell = (page: Page, row: number, column: string) => page.locator(`td[data-selection-row="shortcut-${row}"][data-selection-column="${column}"]`);
const columnHeader = (page: Page, key: string) => page.locator(`thead th[data-selection-column="${key}"]`);
const columnOrder = (page: Page) => page.locator("thead th[data-selection-column]").evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.selectionColumn));
async function dragColumns(page: Page, from: string, to: string, shift = false) {
  const start = (await columnHeader(page, from).boundingBox())!, end = (await columnHeader(page, to).boundingBox())!;
  await page.mouse.move(start.x + 18, start.y + 14);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(end.x + 18, end.y + 14, { steps: 8 });
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
}
async function clickColumnAction(page: Page, label: string, action: string) {
  const escapedAction = action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const item = page.getByRole("menu", { name: `列操作：${label}`, exact: true }).getByRole("menuitem", { name: new RegExp(`(?:^|\\s)${escapedAction}$`) });
  await clickReadyMenuItem(item);
}
async function clickReadyMenuItem(item: Locator) {
  // Wait for the opening animation and popup alignment before moving the pointer.
  await expect.poll(async () => {
    const state = await item.evaluate(element => {
    const popup = element.closest<HTMLElement>(".ant-dropdown")!;
    const rect = element.getBoundingClientRect();
    return {
      positioned: getComputedStyle(popup).position === "absolute",
      moving: /ant-slide-up-(appear|enter|leave)/.test(popup.className),
      hit: element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
    };
    });
    return state;
  }).toEqual({ positioned: true, moving: false, hit: true });
  await item.click();
}

test("search occupies the shared topbar and the selection footer stays at the viewport bottom on scroll and resize", async ({ page }) => {
  await fixture(page);
  const search = page.getByRole("search", { name: "当前页面搜索", exact: true });
  await expect(search.getByLabel("搜索选款", { exact: true })).toBeVisible();
  await expect(page.locator(".content > .page-heading")).toHaveCount(0);
  const footer = page.locator(".selection-bulk-add"), sheet = page.locator(".selection-sheet");
  const bottom = async () => { const bounds = (await footer.boundingBox())!; return Math.round(bounds.y + bounds.height); };
  await expect.poll(async () => Math.abs(await bottom() - 1000)).toBeLessThanOrEqual(1);
  await sheet.evaluate(element => { element.scrollTop = 500; });
  await expect.poll(async () => Math.abs(await bottom() - 1000)).toBeLessThanOrEqual(1);
  await search.getByLabel("搜索选款", { exact: true }).fill("SHORTCUT-24");
  await expect(page.locator("td[data-selection-column='xutiStyleNo']")).toHaveCount(1);
  await expect.poll(async () => Math.abs(await bottom() - 1000)).toBeLessThanOrEqual(1);
  await search.getByLabel("搜索选款", { exact: true }).fill("SHORTCUT-0\nSHORTCUT-24");
  await expect(page.locator("td[data-selection-column='xutiStyleNo']")).toHaveCount(2);
  await expect.poll(async () => {
    const control = (await search.boundingBox())!, header = (await page.getByRole("banner").boundingBox())!;
    return control.y >= header.y && control.y + control.height <= header.y + header.height + 1;
  }).toBe(true);
  await expect.poll(async () => Math.abs(await bottom() - 1000)).toBeLessThanOrEqual(1);
  await search.getByLabel("搜索选款", { exact: true }).fill("");
  await page.screenshot({ path: ".local/selection-compact-layout.png" });
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(search.getByLabel("搜索选款", { exact: true })).toBeVisible();
  await expect.poll(async () => Math.abs(await bottom() - 700)).toBeLessThanOrEqual(1);
  await expect(footer.getByRole("button", { name: "添加 10 行" })).toBeVisible();
  await page.goto("/help");
  await expect(search.getByLabel("搜索使用手册", { exact: true })).toBeVisible();
  await expect(page.getByLabel("搜索选款", { exact: true })).toHaveCount(0);
  await expect(page.locator(".selection-workspace-content")).toHaveCount(0);
});

test("filled-axis shortcuts include internal gaps and zero but stop before trailing blanks and other pages", async ({ page }) => {
  await fixture(page);
  await cell(page, 2, "xutiStyleNo").click();
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect(page.locator('td[data-selection-column="xutiStyleNo"].selection-cell-active')).toHaveCount(15);
  await expect(cell(page, 5, "xutiStyleNo")).toHaveClass(/selection-cell-active/);
  await expect(cell(page, 15, "xutiStyleNo")).not.toHaveClass(/selection-cell-active/);
  const copied = await page.locator(".selection-sheet table").evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData("text/plain");
  });
  expect(copied.split("\n")).toHaveLength(15);
  expect(copied.split("\n")[5]).toBe("");
  expect(copied.split("\n").at(-1)).toBe("SHORTCUT-14");
  await cell(page, 0, "vipPrice").click();
  await page.keyboard.press("Control+Shift+ArrowUp");
  await expect(page.locator('td[data-selection-column="vipPrice"].selection-cell-active')).toHaveCount(18);
  await expect(cell(page, 17, "vipPrice")).toHaveClass(/selection-cell-active/);
  await expect(cell(page, 18, "vipPrice")).not.toHaveClass(/selection-cell-active/);
  await cell(page, 0, "images").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect(page.locator('td[data-selection-column="images"].selection-cell-active')).toHaveCount(4);
  await page.locator(".selection-pagination .ant-pagination-next").click();
  await expect(page.locator('td[data-selection-column="xutiStyleNo"]')).toHaveCount(6);
  await cell(page, 21, "xutiStyleNo").click();
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect(page.locator('td[data-selection-column="xutiStyleNo"].selection-cell-active')).toHaveCount(6);
});

test("row shortcuts use visible fields, empty axes retain selection and text editing keeps native word selection", async ({ page }) => {
  await fixture(page);
  await cell(page, 3, "material").click();
  await page.keyboard.press("Control+Shift+ArrowRight");
  await expect(page.locator("td.selection-cell-active")).toHaveCount(9);
  await expect(cell(page, 3, "registrationBatch")).toHaveClass(/selection-cell-active/);
  await expect(cell(page, 3, "material")).toHaveClass(/selection-cell-active/);
  await expect(cell(page, 3, "supplyPriceExclTax")).not.toHaveClass(/selection-cell-active/);
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await expect(page.locator("td.selection-cell-active")).toHaveCount(9);
  await cell(page, 0, "custom:photos").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect(page.locator("td.selection-cell-active")).toHaveCount(1);
  const editor = cell(page, 3, "supplierStyleNo").locator("textarea");
  await editor.dblclick();
  await editor.evaluate(element => { const input = element as HTMLTextAreaElement; input.setSelectionRange(input.value.length, input.value.length); });
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await expect(page.locator("td.selection-cell-active")).toHaveCount(1);
  expect(await editor.evaluate(element => { const input = element as HTMLTextAreaElement; return input.value.slice(input.selectionStart, input.selectionEnd).trim(); })).toBe("words");
});

test("floating preview permits saving and scrolling the table, retains drag position and supports zoom and right-click actions", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fixture(page);
  await cell(page, 0, "labelImages").locator("img").click();
  const preview = page.locator(".selection-image-preview-layer"), image = preview.locator(".selection-preview-image");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("aria-modal", "false");
  const saved = page.waitForResponse(response => response.url().endsWith("/style-selections/shortcut-0") && response.request().method() === "PATCH");
  await cell(page, 0, "registrationBatch").locator("input").fill("2026-10-04");
  await saved;
  await expect(cell(page, 0, "registrationBatch").locator("input")).toHaveValue("2026-10-04");
  await expect(preview).toBeVisible();
  const sheet = page.locator(".selection-sheet"), sheetBounds = await sheet.boundingBox();
  await page.mouse.move(sheetBounds!.x + 65, sheetBounds!.y + 160);
  await page.mouse.wheel(0, 550);
  await expect.poll(() => sheet.evaluate(element => element.scrollTop)).toBeGreaterThan(300);
  await expect(preview).toBeVisible();
  const before = await image.boundingBox();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2 + 240, before!.y + before!.height / 2 + 35, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await image.boundingBox())!.x).toBeCloseTo(before!.x + 240, 0);
  await page.getByRole("button", { name: "放大图片", exact: true }).click();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(before!.width);
  await image.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "复制当前图片" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "下载当前图片" })).toBeVisible();
  await clickReadyMenuItem(page.getByRole("menuitem", { name: "复制图片地址" }));
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:5174${imageUrls[0]}`);
  await page.getByRole("button", { name: "向右旋转图片", exact: true }).click();
  await page.getByRole("button", { name: "重置图片预览", exact: true }).click();
  await expect.poll(async () => (await image.boundingBox())!.x).toBeCloseTo(before!.x, 0);
  await page.screenshot({ path: ".local/selection-floating-preview.png" });
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
});

test("readonly users can fix multiple columns from headers or cells, retain alignment when scrolling and restore saved settings", async ({ page }) => {
  await fixture(page, true);
  const sheet = page.locator(".selection-sheet");
  const header = (key: string) => page.locator(`thead th[data-selection-column="${key}"]`);
  await header("xutiStyleNo").click({ button: "right" });
  await clickColumnAction(page, "序缇款号", "固定此列");
  await expect(header("xutiStyleNo")).toHaveAttribute("data-fixed-column", "true");
  await header("supplierStyleNo").click({ button: "right" });
  await clickColumnAction(page, "供应商款号", "固定此列");
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(2);
  const before = await header("xutiStyleNo").boundingBox();
  await sheet.evaluate(element => { element.scrollLeft = 400; });
  await expect.poll(async () => (await header("xutiStyleNo").boundingBox())!.x).toBeCloseTo(before!.x, 0);
  await cell(page, 0, "xutiStyleNo").click();
  await expect.poll(async () => (await cell(page, 0, "xutiStyleNo").boundingBox())!.x).toBeCloseTo(before!.x, 0);
  expect(await cell(page, 0, "xutiStyleNo").evaluate(element => getComputedStyle(element).position)).toBe("sticky");
  const fixedCellBounds = await cell(page, 0, "xutiStyleNo").boundingBox();
  for (const x of [fixedCellBounds!.x + 12, fixedCellBounds!.x + fixedCellBounds!.width - 28]) {
    expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("td")?.dataset.selectionColumn, { x, y: fixedCellBounds!.y + 12 })).toBe("xutiStyleNo");
  }
  await page.screenshot({ path: ".local/selection-fixed-columns.png" });
  await cell(page, 0, "xutiStyleNo").click({ button: "right" });
  await clickColumnAction(page, "序缇款号", "取消固定此列");
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(1);
  await cell(page, 3, "material").click();
  await page.keyboard.press("Control+Shift+ArrowRight");
  const copied = await page.locator(".selection-sheet table").evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData("text/plain");
  });
  expect(copied.split("\t")[0]).toBe("Supplier words");
  await page.reload();
  await expect(page.locator('td[data-selection-column="xutiStyleNo"]')).toHaveCount(20);
  await expect(header("supplierStyleNo")).toHaveAttribute("data-fixed-column", "true");
  await header("supplierStyleNo").click({ button: "right" });
  await clickColumnAction(page, "供应商款号", "取消所有固定列");
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(0);
  await expect(page.locator("thead th[data-selection-column]").first()).toHaveAttribute("data-selection-column", "registrationBatch");
  const heights: Record<string, number> = {};
  for (const name of ["紧凑行高", "标准行高", "宽松行高", "超宽行高"]) {
    await page.locator(".selection-tool-select").nth(2).click();
    await page.locator(".ant-select-dropdown:visible").getByText(name, { exact: true }).click();
    heights[name] = (await header("xutiStyleNo").boundingBox())!.height;
  }
  console.log("Measured selection header heights:", heights);
});

test("header drag and mixed selections batch pin and unpin columns without disturbing other saved pins", async ({ page }) => {
  await fixture(page, true);
  await columnHeader(page, "supplierCode").click({ button: "right" });
  await clickColumnAction(page, "供应商编码", "固定此列");
  await dragColumns(page, "images", "xutiStyleNo");
  await expect(page.locator("thead th[data-column-selected]")).toHaveCount(3);
  await expect(page.locator("td.selection-cell-active")).toHaveCount(60);
  await cell(page, 0, "images").click({ button: "right", position: { x: 2, y: 2 } });
  await clickColumnAction(page, "图片", "固定所选 3 列");
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(4);
  expect((await columnOrder(page)).slice(0, 4)).toEqual(["images", "labelImages", "xutiStyleNo", "supplierCode"]);
  await columnHeader(page, "xutiStyleNo").click();
  await columnHeader(page, "registrationBatch").click({ modifiers: ["Shift"] });
  await columnHeader(page, "xutiStyleNo").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "列操作：序缇款号", exact: true });
  await expect(menu.getByRole("menuitem", { name: "取消固定所选 3 列" })).toBeVisible();
  await clickColumnAction(page, "序缇款号", "固定所选 3 列");
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(5);
  // Right clicking outside a multi-column selection acts only on that column.
  await columnHeader(page, "images").click();
  await columnHeader(page, "xutiStyleNo").click({ modifiers: ["Shift"] });
  await columnHeader(page, "supplierStyleNo").click({ button: "right" });
  await clickColumnAction(page, "供应商款号", "固定此列");
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(6);
  await columnHeader(page, "images").click();
  await columnHeader(page, "xutiStyleNo").click({ modifiers: ["Shift"] });
  await columnHeader(page, "labelImages").click({ button: "right" });
  await clickColumnAction(page, "洗唛/吊牌图", "取消固定所选 3 列");
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(3);
  await page.reload();
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(3);
  expect((await columnOrder(page)).slice(0, 3)).toEqual(["registrationBatch", "supplierStyleNo", "supplierCode"]);
});

test("Shift header clicks extend and shrink the range while Shift drag still reorders and Escape cancels", async ({ page }) => {
  await fixture(page, true);
  const originalOrder = await columnOrder(page);
  await columnHeader(page, "xutiStyleNo").click();
  await columnHeader(page, "supplierCode").click({ modifiers: ["Shift"] });
  await expect(page.locator("thead th[data-column-selected]")).toHaveCount(3);
  expect(await columnOrder(page)).toEqual(originalOrder);
  await columnHeader(page, "supplierStyleNo").click({ modifiers: ["Shift"] });
  await expect(page.locator("thead th[data-column-selected]")).toHaveCount(2);
  await expect(columnHeader(page, "supplierCode")).toHaveAttribute("aria-selected", "false");
  await columnHeader(page, "labelImages").click({ modifiers: ["Shift"] });
  await expect(page.locator("thead th[data-column-selected]")).toHaveCount(2);
  await expect(columnHeader(page, "labelImages")).toHaveAttribute("aria-selected", "true");
  await dragColumns(page, "color", "sizeRange", true);
  const reordered = [...originalOrder];
  reordered.splice(reordered.indexOf("color"), 1);
  reordered.splice(reordered.indexOf("sizeRange") + 1, 0, "color");
  await expect.poll(() => columnOrder(page)).toEqual(reordered);
  const start = (await columnHeader(page, "sizeRange").boundingBox())!, end = (await columnHeader(page, "color").boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(start.x + 18, start.y + 14);
  await page.mouse.down();
  await page.mouse.move(end.x + 18, end.y + 14, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect(await columnOrder(page)).toEqual(reordered);
  await cell(page, 0, "xutiStyleNo").click();
  await columnHeader(page, "supplierCode").click({ modifiers: ["Shift"] });
  await expect(page.locator("thead th[data-column-selected]")).toHaveCount(1);
  await page.getByRole("textbox", { name: "搜索选款" }).fill("no-matching-record");
  await expect(page.locator("td[data-selection-column]")).toHaveCount(0);
  await columnHeader(page, "images").click();
  await columnHeader(page, "xutiStyleNo").click({ modifiers: ["Shift"] });
  await expect(page.locator("thead th[data-column-selected]")).toHaveCount(3);
  await columnHeader(page, "images").click({ button: "right" });
  await clickColumnAction(page, "图片", "固定所选 3 列");
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(3);
});

test("column width menus apply pixels or centimeters to the selection, preserve unit conversions and sticky offsets", async ({ page }) => {
  await fixture(page, true);
  await columnHeader(page, "images").click();
  await columnHeader(page, "xutiStyleNo").click({ modifiers: ["Shift"] });
  await columnHeader(page, "labelImages").click({ button: "right" });
  await clickColumnAction(page, "洗唛/吊牌图", "设置列宽");
  const dialog = page.getByRole("dialog", { name: "设置列宽", exact: true });
  const number = dialog.getByRole("spinbutton", { name: "列宽数值" });
  await expect(dialog).toContainText("已选择 3 列");
  await expect(number).toHaveValue("120");
  const changeUnit = async (name: string) => {
    await dialog.getByRole("combobox", { name: "列宽单位" }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: name }).click();
  };
  await changeUnit("厘米 (cm)");
  await expect(number).toHaveValue("3.18");
  await changeUnit("像素 (px)");
  await expect(number).toHaveValue("120");
  await changeUnit("厘米 (cm)");
  await number.fill("8.38");
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  for (const key of ["images", "labelImages", "xutiStyleNo"]) await expect(columnHeader(page, key)).toHaveCSS("width", "317px");
  await expect(columnHeader(page, "supplierStyleNo")).toHaveCSS("width", "120px");
  await columnHeader(page, "labelImages").click({ button: "right" });
  await clickColumnAction(page, "洗唛/吊牌图", "固定所选 3 列");
  await cell(page, 0, "images").click({ button: "right", position: { x: 2, y: 2 } });
  await clickColumnAction(page, "图片", "设置列宽");
  await number.fill("260");
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await expect(columnHeader(page, "images")).toHaveCSS("width", "260px");
  const imageBounds = (await columnHeader(page, "images").boundingBox())!, labelBounds = (await columnHeader(page, "labelImages").boundingBox())!;
  expect(labelBounds.x - imageBounds.x).toBe(260);
  await columnHeader(page, "xutiStyleNo").click({ button: "right" });
  await clickColumnAction(page, "序缇款号", "设置列宽");
  await number.fill("");
  await expect(dialog.getByRole("button", { name: "确定", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(columnHeader(page, "xutiStyleNo")).toHaveCSS("width", "317px");
  await page.reload();
  await expect(columnHeader(page, "images")).toHaveCSS("width", "260px");
  await expect(columnHeader(page, "xutiStyleNo")).toHaveCSS("width", "317px");
  await expect(page.locator("thead th[data-fixed-column]")).toHaveCount(3);
  await page.screenshot({ path: ".local/selection-column-widths.png" });
});

test("gallery enlargement becomes modeless for readonly users and switching another field keeps one preview", async ({ page }) => {
  await fixture(page, true);
  await cell(page, 0, "images").getByRole("button", { name: "全部", exact: true }).click();
  await page.locator(".selection-image-gallery img").first().click();
  const preview = page.locator(".selection-image-preview-layer");
  await expect(preview).toBeVisible();
  await expect(page.locator(".ant-modal-wrap:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "下一张大图", exact: true }).click();
  await expect(preview.locator("img")).toHaveAttribute("src", imageUrls[1]);
  await expect(cell(page, 0, "registrationBatch").locator("input")).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  await cell(page, 0, "labelImages").locator("img").click();
  await expect(preview).toHaveCount(1);
  await expect(preview).toHaveAttribute("aria-label", "洗唛/吊牌图图片预览");
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await cell(page, 0, "images").click({ position: { x: 2, y: 2 } });
  const summary = cell(page, 0, "images").locator(".selection-image-summary");
  await summary.focus();
  await page.keyboard.press("Space");
  await expect(preview).toBeVisible();
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  await summary.focus();
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect(page.locator('td[data-selection-column="images"].selection-cell-active')).toHaveCount(4);
});

test("choice cells start blank, save colored single and multiple labels and retain each option color after reload", async ({ page }) => {
  await fixture(page, false, true);
  const single = cell(page, 0, "custom:check"), multiple = cell(page, 0, "custom:action");
  await expect(single).toHaveText("");
  await expect(multiple).toHaveText("");
  await expect(single.locator(".ant-select")).toHaveCount(0);
  await expect(multiple.locator(".ant-select")).toHaveCount(0);
  await expect(cell(page, 1, "custom:check").locator(".selection-choice-pill")).toHaveText("规范");
  await expect(cell(page, 2, "custom:action").locator(".selection-choice-pill")).toHaveCount(2);
  await single.click();
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  await expect(single.locator(".ant-select")).toHaveCount(0);
  await single.getByRole("button", { name: "展开洗涤标志核对选项", exact: true }).click();
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(1);
  await single.getByRole("button", { name: "收起洗涤标志核对选项", exact: true }).click();
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  await single.getByRole("button", { name: "展开洗涤标志核对选项", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^不规范$/ }).click();
  await multiple.click();
  await multiple.getByRole("button", { name: "展开衣服整改措施选项", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^换洗唛$/ }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^缝领标$/ }).click();
  const saved = page.waitForResponse(response => response.url().endsWith("/style-selections/shortcut-0") && response.request().method() === "PATCH");
  await cell(page, 0, "material").click();
  await saved;
  await expect(single.locator(".selection-choice-pill")).toHaveText("不规范");
  expect(new Set(await multiple.locator(".selection-choice-pill").evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor))).size).toBe(2);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "编辑字段洗涤标志核对", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑字段", exact: true });
  await dialog.getByLabel("标签颜色：不规范", { exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^暖灰$/ }).click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(single.locator(".selection-choice-pill")).toHaveCSS("background-color", "rgb(119, 115, 111)");
  await page.reload();
  await expect(single.locator(".selection-choice-pill")).toHaveCSS("background-color", "rgb(119, 115, 111)");
  await expect(multiple.locator(".selection-choice-pill")).toHaveCount(2);
  await single.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".local/selection-choice-labels.png" });
  await multiple.click();
  await multiple.getByRole("button", { name: "展开衣服整改措施选项", exact: true }).click();
  await multiple.getByRole("button", { name: "移除换洗唛", exact: true }).click();
  await cell(page, 0, "material").click();
  await expect(multiple.locator(".selection-choice-pill")).toHaveText("缝领标");
});

test("choice cells open only from the icon, close on table scroll and retain selections and option-list scrolling", async ({ page }) => {
  await fixture(page, false, true);
  const sheet = page.locator(".selection-sheet"), single = cell(page, 0, "custom:check"), multiple = cell(page, 2, "custom:action");
  const popup = page.locator(".ant-select-dropdown:visible");
  await single.click();
  await expect(popup).toHaveCount(0);
  await single.click();
  await expect(popup).toHaveCount(0);
  await single.getByRole("button", { name: "展开洗涤标志核对选项", exact: true }).click();
  await expect(popup).toHaveCount(1);
  await popup.dispatchEvent("scroll");
  await expect(popup).toHaveCount(1);
  const bounds = (await sheet.boundingBox())!;
  await page.mouse.move(bounds.x + 20, bounds.y + 140);
  await page.mouse.wheel(0, 180);
  await expect(popup).toHaveCount(0);
  await single.scrollIntoViewIfNeeded();
  await single.getByRole("button", { name: "展开洗涤标志核对选项", exact: true }).click();
  await expect(popup).toHaveCount(1);
  await sheet.evaluate(element => { element.scrollTop += 200; });
  await expect(popup).toHaveCount(0);
  await multiple.click();
  await expect(popup).toHaveCount(0);
  await multiple.getByRole("button", { name: "展开衣服整改措施选项", exact: true }).click();
  await expect(popup).toHaveCount(1);
  await popup.dispatchEvent("wheel", { deltaY: 60 });
  await expect(popup).toHaveCount(1);
  await sheet.evaluate(element => { element.scrollLeft -= 100; });
  await expect(popup).toHaveCount(0);
  await expect(multiple.locator(".selection-choice-pill")).toHaveCount(2);
  await multiple.getByRole("group", { name: "衣服整改措施", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(popup).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

test("readonly choice cells show saved labels and keep empty cells free of editors", async ({ page }) => {
  await fixture(page, true, true);
  await cell(page, 0, "custom:check").click();
  await expect(cell(page, 0, "custom:check")).toHaveText("");
  await expect(cell(page, 0, "custom:check").locator(".ant-select")).toHaveCount(0);
  await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  await expect(cell(page, 1, "custom:check").locator(".selection-choice-pill")).toHaveText("规范");
});

test("field group tabs locate columns without pins and move groups after pins while retaining other fields", async ({ page }) => {
  await fixture(page, true, true);
  const header = (key: string) => page.locator(`thead th[data-selection-column="${key}"]`);
  const order = () => page.locator("thead th[data-selection-column]").evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.selectionColumn));
  const initial = await order();
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "配置字段分组", exact: true });
  await dialog.getByRole("button", { name: "添加分组", exact: true }).click();
  await dialog.getByLabel("分组名称1", { exact: true }).fill("质检");
  const picker = dialog.getByLabel("分组字段1", { exact: true });
  await picker.click();
  for (const name of ["洗涤标志核对", "衣服整改措施", "洗唛/吊牌图"]) {
    await picker.fill(name);
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: new RegExp(`^${name}$`) }).click();
    await expect(dialog.locator(".selection-column-group-config .ant-select")).toContainText(name);
  }
  await dialog.getByLabel("分组名称1", { exact: true }).click();
  await dialog.getByRole("button", { name: "保存分组", exact: true }).click();
  const tab = page.getByRole("tab", { name: "质检", exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  expect(await order()).toEqual(initial);
  await expect.poll(() => page.locator(".selection-sheet").evaluate(element => element.scrollLeft)).toBeGreaterThan(150);
  await page.locator(".selection-sheet").evaluate(element => { element.scrollLeft = 0; });
  await tab.click();
  await expect.poll(() => page.locator(".selection-sheet").evaluate(element => element.scrollLeft)).toBeGreaterThan(150);
  await page.getByRole("tab", { name: "全部字段", exact: true }).click();
  await header("xutiStyleNo").click({ button: "right" });
  await clickColumnAction(page, "序缇款号", "固定此列");
  await header("registrationBatch").click({ button: "right" });
  await clickColumnAction(page, "登记批次", "固定此列");
  await tab.click();
  expect((await order()).slice(0, 5)).toEqual(["registrationBatch", "xutiStyleNo", "labelImages", "custom:check", "custom:action"]);
  expect(new Set(await order())).toEqual(new Set(initial));
  await expect.poll(() => page.locator(".selection-sheet").evaluate(element => element.scrollLeft)).toBe(0);
  expect((await header("labelImages").boundingBox())!.x).toBeCloseTo((await header("xutiStyleNo").boundingBox())!.x + 120, 0);
  await cell(page, 2, "custom:action").click();
  await page.keyboard.press("Control+Shift+ArrowRight");
  const copied = await page.locator(".selection-sheet table").evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData("text/plain");
  });
  expect(copied.split("\t").slice(0, 5)).toEqual(["", "SHORTCUT-2", "", "", "换洗唛/缝领标"]);
  await page.screenshot({ path: ".local/selection-column-groups.png" });
  await page.getByRole("tab", { name: "全部字段", exact: true }).click();
  expect(await order()).toEqual(["registrationBatch", "xutiStyleNo", ...initial.filter(key => key !== "registrationBatch" && key !== "xutiStyleNo")]);
  await page.reload();
  await expect(tab).toBeVisible();
  await expect(page.getByRole("tab", { name: "全部字段", exact: true })).toHaveAttribute("aria-selected", "true");
  await tab.click();
  expect((await order()).slice(0, 5)).toEqual(["registrationBatch", "xutiStyleNo", "labelImages", "custom:check", "custom:action"]);
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  await dialog.getByLabel("分组名称1", { exact: true }).fill("质检编辑");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(tab).toBeVisible();
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  await dialog.getByRole("button", { name: "删除分组1", exact: true }).click();
  await dialog.getByRole("button", { name: "保存分组", exact: true }).click();
  await expect(page.locator(".selection-column-group-tabs")).toHaveCount(0);
  expect(await order()).toEqual(["registrationBatch", "xutiStyleNo", ...initial.filter(key => key !== "registrationBatch" && key !== "xutiStyleNo")]);
});

test("large page selection timing", async ({ page }) => {
  test.skip(!process.env.SELECTION_PERF, "Run on demand to compare browser selection latency");
  test.setTimeout(180000);
  await fixture(page, false, true, 1000);
  for (const count of [20, 100, 500, 1000]) {
    await page.evaluate(count => localStorage.setItem("style-selection-page-size-v1", String(count)), count);
    await page.reload();
    await expect(page.locator('td[data-selection-column="xutiStyleNo"]')).toHaveCount(count, { timeout: 30000 });
    const samples = await page.evaluate(async () => {
      const samples: number[] = [], pressSamples: number[] = [];
      for (let index = 0; index < 12; index++) {
        const target = document.querySelector<HTMLElement>(`td[data-selection-row="shortcut-${index % 3}"][data-selection-column="${index % 2 ? "supplierStyleNo" : "xutiStyleNo"}"]`)!;
        const rect = target.getBoundingClientRect(), start = performance.now();
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: rect.x + 2, clientY: rect.y + 2 }));
        pressSamples.push(performance.now() - start);
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        samples.push(performance.now() - start);
      }
      return { paint: samples.slice(2).sort((a, b) => a - b), press: pressSamples.slice(2).sort((a, b) => a - b) };
    });
    console.log(JSON.stringify({ rows: count, selectionMedianMs: samples.paint[5], selectionP95Ms: samples.paint.at(-1), pressMedianMs: samples.press[5] }));
  }
});
