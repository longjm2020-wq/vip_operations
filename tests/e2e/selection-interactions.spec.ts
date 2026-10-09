import { expect, test, type Locator, type Page } from "@playwright/test";
import type { z } from "zod";
import type { selectionLayoutSnapshotSchema } from "../../packages/contracts/src/selection-layout.js";
type SelectionLayoutSnapshot = z.input<typeof selectionLayoutSnapshotSchema>;
import { readFile } from "node:fs/promises";

const imageUrls = ["/api/v1/style-selections/images/preview-a", "/api/v1/style-selections/images/preview-b"];
test("readonly users add a private field and explicitly publish or withdraw it", async ({page})=>{
  const userId="201", layouts=await fixture(page,true,false,3,userId);
  await expect.poll(()=>layouts.get(userId)?.revision || 0).toBeGreaterThan(0);
  const modern=()=>({...layouts.get(userId),sharedRevision:0,sharedPreferences:null,canEditShared:false});
  await page.route("**/api/v1/style-selections/layout-preferences?**",async route=>{
    if(route.request().method()==="POST") {
      const body=route.request().postDataJSON(),before=layouts.get(userId)!;
      expect(body.sharedChanges).toBeUndefined();
      layouts.set(userId,{revision:before.revision+1,preferences:{...body.preferences,columns:body.preferences.columns.map((field:any)=>field.ownerId?{...field,ownerId:userId,visibility:field.visibility || "PRIVATE",fieldRevision:field.fieldRevision || 1}:field)}});
    }
    await route.fulfill({json:{data:modern()}});
  });
  const changes:boolean[]=[];
  await page.route("**/api/v1/style-selections/fields/*/visibility",async route=>{
    const body=route.request().postDataJSON(),key=decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
    const before=layouts.get(userId)!,field=before.preferences!.columns.find(field=>field.key===key)!;
    expect(body.revision).toBe(field.fieldRevision);changes.push(body.public);
    const saved={...field,visibility:body.public?"PUBLIC" as const:"PRIVATE" as const,fieldRevision:(field.fieldRevision || 0)+1};
    layouts.set(userId,{...before,preferences:{...before.preferences!,columns:before.preferences!.columns.map(field=>field.key===key?saved:field)}});
    await route.fulfill({json:{data:saved}});
  });
  await page.getByRole("button",{name:"字段管理",exact:true}).click();
  await page.getByRole("button",{name:"添加字段",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"添加字段",exact:true});
  await expect(dialog).toContainText("默认私有");
  await dialog.getByLabel("字段名称",{exact:true}).fill("我的备注");
  await dialog.getByRole("button",{name:"保存",exact:true}).click();
  await expect.poll(()=>layouts.get(userId)?.preferences?.columns.find(field=>field.label==="我的备注")?.visibility).toBe("PRIVATE");
  await page.getByRole("button",{name:"字段管理",exact:true}).click();
  await page.getByRole("button",{name:"公开字段我的备注",exact:true}).click();
  await expect(page.getByRole("button",{name:"取消公开字段我的备注",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"取消公开字段我的备注",exact:true}).click();
  await expect(page.getByRole("button",{name:"公开字段我的备注",exact:true})).toBeVisible();
  expect(changes).toEqual([true,false]);
  await expect(page.getByRole("button",{name:/添加一行$/})).toBeDisabled();
});
async function fixture(page: Page, readonly = false, choiceFields = false, rowCount = 26, userId = "101", layouts = new Map<string, SelectionLayoutSnapshot>()) {
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
      id: userId, displayName: "交互测试", roleCodes: [], csrfToken: "fixture",
      permissions: readonly ? ["selection.read"] : ["selection.read", "selection.manage"],
    };
    if (path.endsWith("/revision")) data = { revision: `interactions-${revision}` };
    if (path.endsWith("/sync")) data = {
      revision: `interactions-${revision}`, index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows,
    };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      const current = layouts.get(userId) || { preferences: null, revision: 0 };
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        if (body.revision !== current.revision) { await route.fulfill({ status: 409, json: { error: { message: "其他设备已更新设置" } } }); return; }
        layouts.set(userId, { preferences: body.preferences, revision: current.revision + 1 });
      }
      data = layouts.get(userId) || current;
    }
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
  await expect(page.locator('td[data-selection-column="xutiStyleNo"]').first()).toBeVisible();
  return layouts;
}
const cell = (page: Page, row: number, column: string) => page.locator(`td[data-selection-row="shortcut-${row}"][data-selection-column="${column}"]`);
const columnHeader = (page: Page, key: string) => page.locator(`thead th[data-selection-column="${key}"]`);
const columnOrder = (page: Page) => page.locator("thead th[data-selection-column]").evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.selectionColumn));
async function photoFixture(page: Page, readonly = false) {
  await fixture(page, readonly);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 700;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white"; context.fillRect(0, 0, 900, 700);
    context.fillStyle = "black"; context.font = "48px Arial";
    ["OUTSIDE REGION", "61.3% Polyester", "33.7% Viscose fiber", "2.1% Vinegar fiber", "1.8% Spandex", "1.1% Sheep wool"].forEach((line, index) => context.fillText(line, 60, 80 + index * 95));
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const body = Buffer.from(png, "base64");
  await page.route("**/api/v1/style-selections/images/preview-*", route => route.fulfill({ contentType: "image/png", body }));
  await page.reload();
  await expect(cell(page, 0, "labelImages").locator("img")).toBeVisible();
  return body;
}
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
  await search.getByLabel("搜索选款", { exact: true }).focus();
  await search.screenshot({ path: ".local/selection-search-focus.png" });
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
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(imageUrls[0], page.url()).href);
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
  const layouts = await fixture(page, true, true);
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
  await expect(page.locator("th[data-column-group-active]")).toHaveCount(3);
  expect(await order()).toEqual(initial);
  await expect.poll(() => page.locator(".selection-sheet").evaluate(element => element.scrollLeft)).toBeGreaterThan(150);
  await page.locator(".selection-sheet").evaluate(element => { element.scrollLeft = 0; });
  await tab.click();
  await expect.poll(() => page.locator(".selection-sheet").evaluate(element => element.scrollLeft)).toBeGreaterThan(150);
  await page.getByRole("tab", { name: "全部字段", exact: true }).click();
  await expect(page.locator("th[data-column-group-active]")).toHaveCount(0);
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
  await expect.poll(() => layouts.get("interaction-tester")?.preferences?.columnGroupId).toBeTruthy();
  await expect(page.getByLabel("个人设置同步")).toHaveCount(0);
  await page.reload();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  expect((await order()).slice(0, 5)).toEqual(["registrationBatch", "xutiStyleNo", "labelImages", "custom:check", "custom:action"]);
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

test("personal fields, ordering, pins, groups and view settings restore in fresh browsers without leaking to another account", async ({ page, browser }) => {
  const layouts = await fixture(page, false, true);
  await expect.poll(() => layouts.get("interaction-tester")?.revision || 0).toBeGreaterThan(0);
  await expect(page.getByLabel("个人设置同步")).toHaveCount(0);
  await dragColumns(page, "supplierCode", "images", true);
  await columnHeader(page, "xutiStyleNo").click({ button: "right" });
  await clickColumnAction(page, "序缇款号", "固定此列");
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "添加字段", exact: true }).click();
  const field = page.getByRole("dialog", { name: "添加字段", exact: true });
  await field.getByLabel("字段名称", { exact: true }).fill("补充说明");
  await field.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "字段分组", exact: true }).click();
  const group = page.getByRole("dialog", { name: "配置字段分组", exact: true });
  await group.getByRole("button", { name: "添加分组", exact: true }).click();
  await group.getByLabel("分组名称1", { exact: true }).fill("我的质检");
  await group.getByLabel("分组字段1", { exact: true }).fill("洗涤标志核对");
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^洗涤标志核对$/ }).click();
  await group.getByLabel("分组名称1", { exact: true }).click();
  await group.getByRole("button", { name: "保存分组", exact: true }).click();
  await page.getByRole("tab", { name: "我的质检", exact: true }).click();
  await page.getByText("超宽行高", { exact: true }).click();
  await page.getByText("标准行高", { exact: true }).click();
  await page.locator(".selection-pagination .ant-select").click();
  await page.getByText("50 条/页", { exact: true }).click();
  await page.getByRole("textbox", { name: "搜索选款", exact: true }).fill("SHORTCUT");
  await expect.poll(() => layouts.get("interaction-tester")?.preferences?.searchText).toBe("SHORTCUT");
  await expect(page.getByLabel("个人设置同步")).toHaveCount(0);
  const savedOrder = await columnOrder(page);
  const fresh = await browser.newContext(), second = await fresh.newPage();
  try {
    await fixture(second, false, true, 26, "interaction-tester", layouts);
    await expect(second.getByRole("tab", { name: "我的质检", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(second.getByRole("columnheader", { name: "选择整列：补充说明", exact: true })).toBeVisible();
    expect(await columnOrder(second)).toEqual(savedOrder);
    await expect(columnHeader(second, "xutiStyleNo")).toHaveAttribute("data-fixed-column", "true");
    await expect(second.locator(".selection-toolbar")).toContainText("标准行高");
    await expect(second.locator(".selection-pagination")).toContainText("50 条/页");
    await expect(second.getByRole("textbox", { name: "搜索选款", exact: true })).toHaveValue("SHORTCUT");
    await fixture(page, true, false, 26, "another-user", layouts);
    await expect(page.getByRole("tab", { name: "我的质检", exact: true })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "选择整列：补充说明", exact: true })).toHaveCount(0);
    await expect(columnHeader(page, "xutiStyleNo")).not.toHaveAttribute("data-fixed-column", "true");
    await expect(page.getByRole("textbox", { name: "搜索选款", exact: true })).toHaveValue("");
    await second.screenshot({ path: ".local/selection-cloud-restored.png" });
  } finally { await fresh.close(); }
});

test("failed saves retain pending personal settings across reload and can retry without overwriting a newer device", async ({ page }) => {
  const layouts = await fixture(page, true);
  await expect.poll(() => layouts.get("interaction-tester")?.revision || 0).toBeGreaterThan(0);
  const failure = async (route: import("@playwright/test").Route) => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: { message: "测试网络中断" } } }) : route.fallback();
  await page.route("**/api/v1/style-selections/layout-preferences", failure);
  await columnHeader(page, "xutiStyleNo").click({ button: "right" });
  await clickColumnAction(page, "序缇款号", "固定此列");
  await expect(page.getByLabel("个人设置同步")).toContainText("测试网络中断");
  await page.reload();
  await expect(columnHeader(page, "xutiStyleNo")).toHaveAttribute("data-fixed-column", "true");
  await expect(page.getByLabel("个人设置同步")).toContainText("测试网络中断");
  await page.unroute("**/api/v1/style-selections/layout-preferences", failure);
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect.poll(() => layouts.get("interaction-tester")?.preferences?.fixedColumns).toContain("xutiStyleNo");
  await expect(page.getByLabel("个人设置同步")).toHaveCount(0);
  const saved = layouts.get("interaction-tester")!;
  layouts.set("interaction-tester", { preferences: { ...saved.preferences!, fixedColumns: ["images"] }, revision: saved.revision + 1 });
  await columnHeader(page, "supplierStyleNo").click({ button: "right" });
  await clickColumnAction(page, "供应商款号", "固定此列");
  await expect(page.getByLabel("个人设置同步")).toContainText("其他设备已更新设置");
  await page.getByRole("button", { name: "使用云端设置", exact: true }).click();
  await expect(columnHeader(page, "images")).toHaveAttribute("data-fixed-column", "true");
  await expect(columnHeader(page, "supplierStyleNo")).not.toHaveAttribute("data-fixed-column", "true");
});

test("image text OCR starts on demand, copies from the right-click menu and preserves multiline text in one saved cell", async ({ page, context }) => {
  test.setTimeout(120000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let ocrRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/ocr/")) ocrRequests++; });
  await photoFixture(page);
  await cell(page, 0, "labelImages").locator("img").click();
  expect(ocrRequests).toBe(0);
  const image = page.locator(".selection-preview-image"), text = page.getByRole("textbox", { name: "图片识别文字", exact: true });
  await image.click({ button: "right" });
  await clickReadyMenuItem(page.getByRole("menuitem", { name: /复制图片文字$/ }));
  await expect(text).toHaveValue(/61.3% Polyester/, { timeout: 60000 });
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/Viscose fiber/);
  expect(ocrRequests).toBeGreaterThan(0);
  const edited = "面料：61.3%聚酯纤维\n33.7%粘胶纤维\n里料：100%棉";
  await text.fill(edited);
  await page.getByRole("button", { name: "复制文字", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n?/g, "\n"))).toBe(edited);
  await page.screenshot({ path: ".local/selection-image-text.png" });
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  await cell(page, 0, "material").click();
  const saved = page.waitForResponse(response => response.url().endsWith("/style-selections/shortcut-0") && response.request().method() === "PATCH");
  await page.keyboard.press("Control+V");
  await expect(cell(page, 0, "material").locator("textarea")).toHaveValue(edited);
  expect((await saved).request().postDataJSON().material).toBe(edited);
  await expect(cell(page, 1, "material").locator("textarea")).toHaveValue("");
  await expect(page.locator("td[data-selection-column='material']")).toHaveCount(20);
});

test("original full-photo care label OCR recognizes Chinese material and percentage using bundled accurate models", async ({ page }) => {
  test.setTimeout(120000);
  await fixture(page, true);
  const label = await readFile("tests/fixtures/selection-care-label-original.webp");
  await page.route("**/api/v1/style-selections/images/preview-*", route => route.fulfill({ contentType: "image/webp", body: label }));
  await page.reload();
  await cell(page, 0, "labelImages").locator("img").click();
  await page.getByRole("button", { name: "识别图片文字", exact: true }).click();
  const text = page.getByRole("textbox", { name: "图片识别文字", exact: true });
  await expect(text).toHaveValue(/100%\s*山羊绒/, { timeout: 90000 });
  await expect(text).toHaveValue(/73009.?2021/);
  await page.screenshot({ path: ".local/selection-care-label-ocr.png" });
});

test("readonly users can crop OCR, select and copy text without changing pictures and recover from image fetch failures", async ({ page, context }) => {
  test.setTimeout(120000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const body = await photoFixture(page, true);
  await cell(page, 0, "labelImages").locator("img").click();
  const image = page.locator(".selection-preview-image"), text = page.getByRole("textbox", { name: "图片识别文字", exact: true });
  await page.getByRole("button", { name: "框选识别文字", exact: true }).click();
  const bounds = (await image.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .04, bounds.y + bounds.height * .18);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .8, bounds.y + bounds.height * .43, { steps: 8 });
  await page.mouse.up();
  await expect(text).toHaveValue(/61.3% Polyester/, { timeout: 60000 });
  await expect(text).toHaveValue(/Viscose fiber/);
  expect(await text.inputValue()).not.toMatch(/OUTSIDE|Sheep|Spandex/);
  await text.focus();
  await page.keyboard.press("ArrowRight");
  await expect(image).toHaveAttribute("src", imageUrls[0]);
  await text.fill("棉60%\n粘胶40%");
  await text.evaluate(element => (element as HTMLTextAreaElement).select());
  await page.keyboard.press("Control+C");
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n?/g, "\n"))).toBe("棉60%\n粘胶40%");
  await page.route(`**${imageUrls[1]}`, route => route.request().resourceType() === "fetch" ? route.fulfill({ status: 403 }) : route.fulfill({ contentType: "image/png", body }));
  await page.getByRole("button", { name: "下一张大图", exact: true }).click();
  await expect(text).toHaveCount(0);
  await page.getByRole("button", { name: "识别图片文字", exact: true }).click();
  await expect(page.locator(".selection-preview-text-error")).toContainText("HTTP 403");
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  await expect(cell(page, 0, "material").locator("textarea")).toHaveAttribute("readonly", "");
});

test("switching a picture cancels pending text recognition without putting the previous result on the next image", async ({ page }) => {
  const body = await photoFixture(page);
  let fetched!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { fetched = resolve; }), finish = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${imageUrls[0]}`, async route => {
    if (route.request().resourceType() === "fetch") { fetched(); await finish; }
    await route.fulfill({ contentType: "image/png", body }).catch(() => {});
  });
  await cell(page, 0, "labelImages").locator("img").click();
  await page.getByRole("button", { name: "识别图片文字", exact: true }).click();
  await started;
  await expect(page.locator(".selection-preview-text-panel")).toContainText("正在读取图片");
  await page.getByRole("button", { name: "下一张大图", exact: true }).click();
  release();
  await expect(page.locator(".selection-preview-image")).toHaveAttribute("src", imageUrls[1]);
  await expect(page.locator(".selection-preview-text-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  await expect(page.locator(".selection-image-preview-layer")).toHaveCount(0);
});

test("clicking selected text places the caret, mouse dragging selects text and native select-all deletes only that text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fixture(page);
  const editor = cell(page, 3, "supplierStyleNo").locator("textarea");
  await editor.click();
  const points = await editor.evaluate(element => {
    const input = element as HTMLTextAreaElement, rect = input.getBoundingClientRect(), style = getComputedStyle(input);
    const context = document.createElement("canvas").getContext("2d")!; context.font = style.font;
    const left = rect.x + (rect.width - context.measureText(input.value).width) / 2;
    return { left: left + 1, wordEnd: left + context.measureText("Supplier").width + 1, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(points.wordEnd, points.y);
  const caret = await editor.evaluate(element => (element as HTMLTextAreaElement).selectionStart);
  expect(caret).toBeGreaterThan(0); expect(caret).toBeLessThan("Supplier words".length);
  await page.mouse.move(points.left, points.y); await page.mouse.down();
  await page.mouse.move(points.wordEnd, points.y, { steps: 8 }); await page.mouse.up();
  expect(await editor.evaluate(element => { const input = element as HTMLTextAreaElement; return input.value.slice(input.selectionStart, input.selectionEnd).trim(); })).toBe("Supplier");
  await expect(page.locator("td.selection-cell-active")).toHaveCount(1);
  await expect(page.locator(".selection-sheet")).not.toHaveClass(/selection-dragging/);
  await page.keyboard.press("Control+C");
  expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe("Supplier");
  await page.keyboard.type("Edited");
  await expect(editor).toHaveValue(/Edited.*words/);
  await page.keyboard.press("Control+A");
  expect(await editor.evaluate(element => { const input = element as HTMLTextAreaElement; return input.selectionEnd - input.selectionStart; })).toBe((await editor.inputValue()).length);
  await expect(page.locator("td.selection-cell-active")).toHaveCount(1);
  await page.keyboard.press("Delete");
  await expect(editor).toHaveValue("");
  await expect(cell(page, 3, "material").locator("textarea")).toHaveValue("Cotton");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+ArrowRight");
  await expect(page.locator("td.selection-cell-active")).toHaveCount(9);
});

test("formatted empty prices accept typing from the cell, save decimals and remain blank after clearing", async ({ page }) => {
  await fixture(page);
  const price = cell(page, 0, "supplyPriceExclTax");
  await price.click({ button: "right" });
  await clickColumnAction(page, "供货价（不含税）", "设置单元格格式");
  const format = page.getByRole("dialog", { name: /^设置单元格格式/ });
  await format.getByRole("combobox", { name: "数字格式", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^货币$/ }).click();
  await format.getByRole("button", { name: "应用", exact: true }).click();
  await expect(price.locator(".selection-formatted-value")).toHaveText("");

  await price.click();
  const input = price.locator("input");
  await expect(input).toBeFocused();
  const firstSave = page.waitForResponse(response => response.url().endsWith("/style-selections/shortcut-0") && response.request().method() === "PATCH" && response.request().postDataJSON().supplyPriceExclTax === "58.25");
  await page.keyboard.type("58.25");
  await expect(input).toHaveValue("58.25");
  await firstSave;
  await cell(page, 0, "supplierStyleNo").click();
  await expect(price.locator(".selection-formatted-value")).toHaveText("¥ 58.25");
  await page.reload();
  await expect(price.locator(".selection-formatted-value")).toHaveText("¥ 58.25");

  await price.click();
  await expect(input).toBeFocused();
  await input.click();
  await page.keyboard.press("Control+A");
  expect(await input.evaluate(element => { const editor = element as HTMLInputElement; return editor.selectionEnd! - editor.selectionStart!; })).toBe(5);
  const cleared = page.waitForResponse(response => response.url().endsWith("/style-selections/shortcut-0") && response.request().method() === "PATCH" && response.request().postDataJSON().supplyPriceExclTax === null);
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("");
  await cleared;
  await cell(page, 0, "supplierStyleNo").click();
  await expect(price.locator(".selection-formatted-value")).toHaveText("");
  await page.reload();
  await expect(price.locator(".selection-formatted-value")).toHaveText("");

  await price.scrollIntoViewIfNeeded();
  const start = (await price.boundingBox())!, end = (await cell(page, 1, "supplyPriceExclTax").boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("td.selection-cell-active")).toHaveCount(2);
  await expect(input).toHaveValue("");
});

for (const readonly of [true, false]) {
  test(`formatted prices keep ${readonly ? "view-only account" : "protected cell"} readonly on click and typing`, async ({ page }) => {
    await fixture(page, readonly);
    const row = {
      id: "shortcut-0", xutiStyleNo: "FORMATTED-READONLY", sortOrder: 0,
      supplyPriceExclTax: "42.50", images: [], labelImages: [], extraFields: {},
      updatedAt: "2026-10-04T00:00:00Z",
      cellNumberFormats: { supplyPriceExclTax: { type: "currency", decimals: 2 } },
      ...(!readonly ? { cellAccess: { supplyPriceExclTax: "read" }, defaultCellAccess: "edit" } : {}),
    };
    await page.route("**/api/v1/style-selections/sync*", route => route.fulfill({ json: { data: {
      revision: "interactions-0", index: [{ id: row.id, token: row.updatedAt }], data: [row],
    } } }));
    let writes = 0;
    page.on("request", request => { if (request.method() === "PATCH" && request.url().endsWith("/style-selections/shortcut-0")) writes++; });
    await page.reload();
    const price = cell(page, 0, "supplyPriceExclTax");
    const display = price.getByRole("textbox", { name: "供货价（不含税）", exact: true });
    await expect(display).toHaveAttribute("aria-readonly", "true");
    await price.click();
    await page.keyboard.type("99");
    await expect(display).toHaveText("¥ 42.50");
    await expect(price.locator("input,textarea")).toHaveCount(0);
    expect(writes).toBe(0);
  });
}

test("transparent rectangular selections retain cell grid lines and saved label content", async ({ page }) => {
  await fixture(page, false, true);
  const first = cell(page, 0, "custom:check"), last = cell(page, 3, "custom:action");
  await first.scrollIntoViewIfNeeded();
  const before = await first.evaluate(element => ({ bottom: getComputedStyle(element).borderBottomColor, right: getComputedStyle(element).borderRightColor, background: getComputedStyle(element).backgroundColor }));
  const start = (await first.boundingBox())!, end = (await last.boundingBox())!;
  await page.mouse.move(start.x + 10, start.y + 10); await page.mouse.down();
  await page.mouse.move(end.x + end.width - 10, end.y + end.height - 10, { steps: 8 }); await page.mouse.up();
  await expect(page.locator("td.selection-cell-active")).toHaveCount(8);
  const after = await first.evaluate(element => ({ bottom: getComputedStyle(element).borderBottomColor, right: getComputedStyle(element).borderRightColor, background: getComputedStyle(element).backgroundColor }));
  expect(after).toEqual(before);
  expect(after.bottom).not.toBe("rgba(0, 0, 0, 0)");
  await expect(cell(page, 1, "custom:check")).toContainText("规范");
  await expect(cell(page, 2, "custom:action")).toContainText("换洗唛");
  await page.screenshot({ path: ".local/selection-range-grid.png" });
});

test("type catalog replaces reset, adds reusable named choice types and disabling keeps existing fields working after reload", async ({ page }) => {
  await fixture(page);
  const openCatalog = async () => { await page.getByRole("button", { name: "字段管理", exact: true }).click(); await page.getByRole("button", { name: "字段类型管理", exact: true }).click(); };
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await expect(page.getByRole("button", { name: "初始化字段类型", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "字段类型管理", exact: true }).click();
  const catalog = page.getByRole("dialog", { name: "字段类型管理", exact: true });
  await catalog.getByRole("button", { name: "新增类型", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新增字段类型", exact: true });
  await create.getByLabel("类型名称", { exact: true }).fill("质检结果");
  await create.getByLabel("基础类型", { exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^单选$/ }).click();
  await create.getByLabel("默认候选选项", { exact: true }).fill("规范\n不规范");
  await create.getByRole("button", { name: "保存类型", exact: true }).click();
  await expect(catalog.getByRole("switch", { name: "启用类型：质检结果", exact: true })).toBeChecked();
  await catalog.locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: /添加字段/ }).click();
  const field = page.getByRole("dialog", { name: "添加字段", exact: true });
  await field.getByLabel("字段名称", { exact: true }).fill("面料质检");
  await field.getByLabel("字段类型", { exact: true }).fill("质检结果");
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^质检结果$/ }).click();
  await expect(field.getByLabel("字段选项", { exact: true })).toHaveValue("规范\n不规范");
  await field.getByRole("button", { name: "保存", exact: true }).click();
  const key = (await page.getByRole("columnheader", { name: "选择整列：面料质检", exact: true }).getAttribute("data-selection-column"))!;
  const quality = cell(page, 0, key);
  await quality.click();
  await quality.getByRole("button", { name: "展开面料质检选项", exact: true }).click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^规范$/ }).click();
  await expect(quality).toContainText("规范");
  await openCatalog();
  await catalog.getByRole("switch", { name: "启用类型：质检结果", exact: true }).click();
  await page.screenshot({ path: ".local/selection-type-catalog.png" });
  await catalog.locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "编辑字段面料质检", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑字段", exact: true });
  await expect(edit.getByLabel("字段类型", { exact: true }).locator(".." )).toContainText("质检结果（已停用）");
  await edit.getByRole("button", { name: "取消", exact: true }).click();
  await page.reload();
  await expect(quality).toContainText("规范");
  await openCatalog();
  await expect(catalog.getByRole("switch", { name: "启用类型：质检结果", exact: true })).not.toBeChecked();
  await catalog.getByRole("switch", { name: "启用类型：质检结果", exact: true }).click();
  await expect(catalog.getByRole("switch", { name: "启用类型：质检结果", exact: true })).toBeChecked();
});

test("readonly type catalogs can be inspected but cannot create or disable types", async ({ page }) => {
  await fixture(page, true);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "字段类型管理", exact: true }).click();
  const catalog = page.getByRole("dialog", { name: "字段类型管理", exact: true });
  await expect(catalog.getByRole("button", { name: "新增类型", exact: true })).toBeDisabled();
  for (const control of await catalog.getByRole("switch").all()) await expect(control).toBeDisabled();
});

test("clicking different cell types retains editor height, header position and vertical scroll", async ({ page }) => {
  await fixture(page, false, true);
  await page.evaluate(() => {
    const visible = ["registrationBatch", "xutiStyleNo", "color", "sizeRange", "material", "custom:check", "custom:action"];
    const keys = [...document.querySelectorAll<HTMLElement>("thead th[data-selection-column]")].map(element => element.dataset.selectionColumn!);
    localStorage.setItem("selection-hidden-fields-v1", JSON.stringify(keys.filter(key => !visible.includes(key))));
  });
  await page.reload();
  const sheet = page.locator(".selection-sheet");
  await sheet.evaluate(element => { element.scrollTop = 180; });
  const positions = () => page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>(".selection-sheet")!, editor = document.querySelector<HTMLElement>(".selection-editor-bar")!;
    return { scroll: sheet.scrollTop, window: window.scrollY, top: sheet.getBoundingClientRect().top, editor: editor.getBoundingClientRect().height };
  });
  const before = await positions(), samples: Record<string, Awaited<ReturnType<typeof positions>>> = {};
  for (const column of ["custom:check", "custom:action", "xutiStyleNo", "color", "sizeRange", "material", "registrationBatch"]) {
    await cell(page, 3, column).click();
    samples[column] = await positions();
  }
  await cell(page, 3, "material").click();
  await page.getByRole("group", { name: "单元格编辑栏", exact: true }).locator("textarea").fill("棉60%\n粘胶40%\n里料：棉100%");
  samples.multiline = await positions();
  await cell(page, 3, "sizeRange").click();
  const sizes = page.getByLabel("编辑尺码范围", { exact: true });
  await sizes.click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: /^其他$/ }).click();
  await page.getByLabel("补充尺码", { exact: true }).fill("均码加长");
  samples.customSize = await positions();
  await page.getByLabel("补充尺码", { exact: true }).press("Enter");
  await expect(cell(page, 3, "sizeRange")).toContainText("均码加长");
  samples.savedSize = await positions();
  for (const sample of Object.values(samples)) {
    expect(sample.top).toBeCloseTo(before.top, 0); expect(sample.editor).toBeCloseTo(before.editor, 0); expect(sample.scroll).toBe(before.scroll); expect(sample.window).toBe(before.window);
  }
});

test("cell details expand long text, drag without shifting the sheet, follow selection and save edits", async ({ page }) => {
  await fixture(page);
  const bar = page.getByRole("group", { name:"单元格编辑栏",exact:true });
  await expect(bar.getByRole("button",{name:"展开单元格详情",exact:true})).toBeDisabled();
  await cell(page,3,"material").click();
  const text = ["面料底布：桑蚕丝100%","面料绒毛：粘纤100%","面料填充物：桑蚕丝100%","（含微量其他纤维）",...Array.from({length:15},(_,index)=>`配料${index+1}：桑蚕丝100%`)].join("\n");
  await bar.getByLabel("编辑当前单元格",{exact:true}).fill(text);
  const geometry = () => page.evaluate(()=>({top:document.querySelector(".selection-sheet")!.getBoundingClientRect().top,height:document.querySelector(".selection-editor-bar")!.getBoundingClientRect().height}));
  const before = await geometry();
  await bar.getByRole("button",{name:"展开单元格详情",exact:true}).click();
  const detail = page.getByRole("dialog",{name:"单元格详情",exact:true}), content = detail.getByLabel("单元格详情内容",{exact:true});
  await expect(content).toHaveValue(text);
  await expect(detail).toHaveAttribute("aria-modal","false");
  const initial = (await detail.boundingBox())!, header = (await detail.locator("header").boundingBox())!;
  await page.mouse.move(header.x+60,header.y+20);
  await page.mouse.down();
  await page.mouse.move(header.x-200,header.y+110,{steps:12});
  await page.mouse.up();
  const moved = (await detail.boundingBox())!;
  expect(moved.x).toBeCloseTo(initial.x-260,0);
  expect(moved.y).toBeCloseTo(initial.y+90,0);
  expect(await geometry()).toEqual(before);
  await content.fill(text+"\n已核对");
  await expect(bar.getByLabel("编辑当前单元格",{exact:true})).toHaveValue(text+"\n已核对");
  const saved = page.waitForResponse(response=>response.request().method()==="PATCH" && response.url().includes("/style-selections/shortcut-3"));
  await cell(page,0,"registrationBatch").click();
  await saved;
  await expect(detail.locator("strong")).toHaveText("1 · 登记批次");
  await expect(content).toHaveAttribute("readonly","");
  await bar.getByRole("button",{name:"收起单元格详情",exact:true}).click();
  await expect(detail).toHaveCount(0);
  await cell(page,3,"material").click();
  await bar.getByRole("button",{name:"展开单元格详情",exact:true}).click();
  await expect(content).toHaveValue(text+"\n已核对");
  await page.screenshot({path:".local/selection-text-detail-e2e-20261005.png"});
  await detail.getByRole("button",{name:"收起单元格详情",exact:true}).click();
  await expect(detail).toHaveCount(0);
});

test("picture enlargement keeps draggable text details editable for their original cell", async ({page}) => {
  await fixture(page);
  await cell(page,3,"material").click();
  await page.getByRole("button",{name:"展开单元格详情",exact:true}).click();
  const detail = page.getByRole("dialog",{name:"单元格详情",exact:true});
  const content = detail.getByLabel("单元格详情内容",{exact:true});
  await cell(page,0,"images").locator(".selection-image-slide img").click();
  const preview = page.locator(".selection-image-preview-layer");
  await expect(preview).toBeVisible();
  await expect(detail).toBeVisible();
  await expect(detail.locator("strong")).toHaveText("4 · 材质");
  await expect(content).toHaveValue("Cotton");
  const picture = (await preview.locator(".selection-preview-image").boundingBox())!;
  const panel = (await detail.boundingBox())!;
  expect(picture.x+picture.width).toBeLessThanOrEqual(panel.x);
  const header = (await detail.locator("header").boundingBox())!;
  await page.mouse.move(header.x+60,header.y+20);await page.mouse.down();
  await page.mouse.move(header.x-380,header.y+80,{steps:8});await page.mouse.up();
  const saved = page.waitForResponse(response=>response.request().method()==="PATCH" && response.url().endsWith("/style-selections/shortcut-3"));
  await content.fill("对照图片核对材质");
  await saved;
  await page.getByRole("button",{name:"关闭图片预览",exact:true}).click();
  await expect(preview).toHaveCount(0);
  await expect(content).toHaveValue("对照图片核对材质");
  await cell(page,3,"material").click();
  await expect(page.getByRole("group",{name:"单元格编辑栏",exact:true}).getByLabel("编辑当前单元格",{exact:true})).toHaveValue("对照图片核对材质");
  await detail.getByRole("button",{name:"收起单元格详情",exact:true}).click();
  // The reverse order must also reposition the image controls correctly.
  await cell(page,0,"images").locator(".selection-image-slide img").click();
  await cell(page,3,"material").click();
  await page.getByRole("button",{name:"展开单元格详情",exact:true}).click();
  await expect(content).toHaveValue("对照图片核对材质");
  const shiftedImage = (await preview.locator(".selection-preview-image").boundingBox())!;
  const close = (await page.getByRole("button",{name:"关闭图片预览",exact:true}).boundingBox())!;
  expect(close.x+close.width).toBeLessThanOrEqual(shiftedImage.x+shiftedImage.width);
  await content.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(preview).toBeVisible();
  await page.getByRole("button",{name:"关闭图片预览",exact:true}).click();
});

test("cell details let readonly users select text but never expose denied cells", async ({ page }) => {
  await fixture(page,true);
  let writes=0;
  page.on("request",request=>{if(request.method()==="PATCH") writes++;});
  const bar = page.getByRole("group",{name:"单元格编辑栏",exact:true});
  await cell(page,3,"material").click();
  await bar.getByRole("button",{name:"展开单元格详情",exact:true}).click();
  const detail = page.getByRole("dialog",{name:"单元格详情",exact:true}), content = detail.getByLabel("单元格详情内容",{exact:true});
  await expect(content).toHaveValue("Cotton");
  await expect(content).toHaveAttribute("readonly","");
  await content.press("Control+A");
  expect(await content.evaluate(element => (element as HTMLTextAreaElement).selectionEnd-(element as HTMLTextAreaElement).selectionStart)).toBe(6);
  await page.keyboard.type("cannot change");
  await expect(content).toHaveValue("Cotton");
  await content.press("Escape");
  await expect(detail).toHaveCount(0);
  expect(writes).toBe(0);
  const hidden = {id:"shortcut-0",xutiStyleNo:"HIDDEN",material:"",images:[],labelImages:[],extraFields:{},updatedAt:"2026-10-04T00:00:00Z",cellAccess:{material:"deny"}};
  await page.route("**/api/v1/style-selections/sync*",route=>route.fulfill({json:{data:{revision:"interactions-0",index:[{id:hidden.id,token:hidden.updatedAt}],data:[hidden]}}}));
  await page.reload();
  await cell(page,0,"material").click();
  await expect(bar.getByRole("button",{name:"展开单元格详情",exact:true})).toBeDisabled();
  await expect(detail).toHaveCount(0);
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
