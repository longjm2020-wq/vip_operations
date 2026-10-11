import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { selectionImportLimits } from "../../packages/contracts/src/selection-import-template.js";

type Values = Record<string, any>;
async function workbook(image = false) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("选款资料");
  sheet.addRow(["创建时间", "序缇款号", "长标题", "活动卖点", "唯品价", ...(image ? ["图片"] : [])]);
  sheet.addRow(["1999-01-01", "IMPORT-001", "本次更新标题", "新品上市", "", ...(image ? ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="] : [])]);
  if (!image) sheet.addRow(["", "IMPORT-002", "新增款标题", "新品上市"]);
  return { name: "针对性更新.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await book.xlsx.writeBuffer()) };
}

async function fixture(page: Page, failFirstPreview = false, legacyFirstPreview = false, titleLimit?: number) {
  let preferences = selectionLayoutSchema.parse({ columns: [
    { key: "registrationBatch", label: "创建时间", type: "createdTime" },
    { key: "xutiStyleNo", label: "序缇款号", type: "text" },
    { key: "color", label: "供应商颜色", type: "tags" },
    { key: "custom:title", label: "长标题", type: "text", custom: true, visibility: "PUBLIC", ...(titleLimit ? { textConfig: { countMode: "characters", maxLength: titleLimit } } : {}) },
  ] }), revision = 1;
  const rows: Values[] = [{ id: "1", xutiStyleNo: "IMPORT-001", color: "黑色", vipPrice: "580.00", registrationBatch: "2026-10-05T00:00:00Z", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z", images: [], labelImages: [], extraFields: { "custom:title": "旧标题" } }];
  const previews: Values[] = [], commits: Values[] = [], layoutWrites: Values[] = [], uploads: Values[] = [];
  let releasePreview: (() => void) | undefined;
  const fields = [
    { header: "长标题", key: "custom:title", label: "长标题", type: "text", isNew: false },
    { header: "活动卖点", key: "custom:campaign", label: "活动卖点", type: "text", isNew: true },
  ];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "导入测试", csrfToken: "fixture", roleCodes: ["SUPER_ADMIN"], permissions: ["selection.read", "selection.manage", "product.read", "product.manage", "project.read", "project.create"] };
    if (path.endsWith("/revision")) data = { revision: String(revision) };
    if (path.endsWith("/sync")) data = { revision: String(revision), index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) {
      if (request.method() === "POST") layoutWrites.push(request.postDataJSON());
      data = { preferences, revision, sharedPreferences: projectSelectionSharedLayout(preferences), sharedRevision: revision, canEditShared: true };
    }
    if (path.endsWith("/style-selections/images")) {
      uploads.push(request.postDataJSON());
      data = { url: "/api/v1/style-selections/images/00111111-1111-4111-8111-111111111111" };
    }
    if (path.endsWith("/import/preview")) {
      const body = request.postDataJSON(); previews.push(body);
      if (failFirstPreview && previews.length === 1) {
        await new Promise<void>(resolve => { releasePreview = resolve; });
        await route.fulfill({ status: 409, json: { error: { message: "字段已变化，请重新预览" } } }); return;
      }
      const planned = body.rows.map((values: Values) => {
        const old = rows.find(row => row.xutiStyleNo === values.xutiStyleNo);
        const operation = !old ? "CREATE" : body.existingStrategy === "OVERWRITE" ? "UPDATE" : "SKIP";
        return { values, id: old?.id, expectedUpdatedAt: old?.updatedAt, operation, changedFields: operation === "SKIP" ? [] : [...Object.keys(values.fieldValues || {}), ...(values.images ? ["图片"] : [])] };
      });
      const counts = { created: planned.filter((row: Values) => row.operation === "CREATE").length, updated: planned.filter((row: Values) => row.operation === "UPDATE").length };
      data = legacyFirstPreview && previews.length === 1 ? { rows: planned, ...counts } : { rows: planned, fields, fieldRevision: "11111111111111111111111111111111", layoutRevision: revision, ...counts, skipped: planned.filter((row: Values) => row.operation === "SKIP").length };
    }
    if (path.endsWith("/style-selections/import")) {
      const body = request.postDataJSON(); commits.push(body);
      let created = 0, updated = 0, skipped = 0;
      for (const planned of body.rows) {
        if (planned.operation === "SKIP") { skipped++; continue; }
        const values = planned.values, old = rows.find(row => row.xutiStyleNo === values.xutiStyleNo);
        const next = old || { id: String(rows.length + 1), xutiStyleNo: values.xutiStyleNo, images: [], labelImages: [], extraFields: {}, createdAt: "2026-10-11T00:00:00Z" };
        for (const [header, value] of Object.entries(values.fieldValues || {})) next.extraFields[fields.find(field => field.header === header)!.key] = value;
        if (values.images) next.images = values.images;
        next.updatedAt = "2026-10-11T01:00:00Z";
        if (!old) { rows.push(next); created++; } else updated++;
      }
      preferences = selectionLayoutSchema.parse({ ...preferences, columns: [...preferences.columns, { key: "custom:campaign", label: "活动卖点", type: "text", custom: true, visibility: "PRIVATE", ownerId: "101" }] });
      revision++;
      data = { created, updated, skipped };
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
  return { previews, commits, layoutWrites, uploads, rows, releasePreview: () => releasePreview?.() };
}

async function openImport(page: Page) {
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "下载模板", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "从 Excel 导入商品" }).click();
  return page.getByRole("dialog", { name: "从 Excel 导入商品" });
}

test("同款选择不覆盖或针对性覆盖，自定义字段只在确认后显示，取消不写入", async ({ page }) => {
  const state = await fixture(page), file = await workbook();
  let dialog = await openImport(page);
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await expect(dialog.getByText("请选择已有款处理方式以生成预览。")).toBeVisible();
  expect(state.previews).toHaveLength(0);
  await dialog.getByRole("radio", { name: "不覆盖，保留已有款全部资料" }).check();
  await expect(dialog.getByText("新增 1 款，覆盖更新 0 款，不覆盖 1 款。", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("row").filter({ hasText: "IMPORT-001" })).toContainText("保留已有款全部资料");
  await dialog.getByRole("radio", { name: "覆盖，仅更新本次填写的字段" }).check();
  await expect(dialog.getByText("新增 1 款，覆盖更新 1 款，不覆盖 0 款。", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("row").filter({ hasText: "IMPORT-001" })).toContainText("长标题、活动卖点");
  await expect(dialog.getByText("排在模板默认字段之后，初始仅本人可见：", { exact: true })).toBeVisible();
  expect(state.previews.map(body => body.existingStrategy)).toEqual(["SKIP", "OVERWRITE"]);
  expect(state.previews[1].rows[0]).toEqual({ xutiStyleNo: "IMPORT-001", fieldValues: { "长标题": "本次更新标题", "活动卖点": "新品上市" } });
  expect(state.layoutWrites).toHaveLength(0);
  await dialog.locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  expect(state.commits).toHaveLength(0);
  await expect(page.locator('th[data-selection-column="custom:campaign"]')).toHaveCount(0);

  dialog = await openImport(page);
  await dialog.getByRole("radio", { name: "覆盖，仅更新本次填写的字段" }).check();
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await expect(dialog.getByRole("button", { name: "确认导入" })).toBeVisible();
  await dialog.getByRole("button", { name: "确认导入" }).click();
  await expect(dialog.getByText("导入完成：新增 1 款，覆盖更新 1 款，不覆盖 0 款", { exact: true })).toBeVisible();
  expect(state.commits).toHaveLength(1);
  expect(state.commits[0]).toMatchObject({ existingStrategy: "OVERWRITE", fieldRevision: "11111111111111111111111111111111", layoutRevision: 1, fields: expect.arrayContaining([expect.objectContaining({ header: "活动卖点", isNew: true })]) });
  expect(state.rows[0]).toMatchObject({ color: "黑色", vipPrice: "580.00", createdAt: "2026-10-05T00:00:00Z", extraFields: { "custom:title": "本次更新标题", "custom:campaign": "新品上市" } });
  await dialog.locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator('th[data-selection-column="custom:campaign"]')).toBeVisible();
});

test("文件上限包含200MB边界，超过一字节禁止预览", async ({ page }) => {
  // Exercise the browser File.size branch with a real, small XLSX body, without
  // allocating a 200 MB fixture merely to verify the inclusive boundary.
  await page.addInitScript(({ maxFileBytes }) => {
    const originalSize = Object.getOwnPropertyDescriptor(Blob.prototype, "size")!.get!;
    Object.defineProperty(File.prototype, "size", { configurable: true, get() {
      return this.name === "边界大小.xlsx" ? maxFileBytes : this.name === "超过边界.xlsx" ? maxFileBytes + 1 : originalSize.call(this);
    } });
  }, { maxFileBytes: selectionImportLimits.maxFileBytes });
  const state = await fixture(page), dialog = await openImport(page), file = await workbook();
  await expect(dialog.getByText("仅支持 .xlsx 文件，不超过 200 MB，每次最多 5000 款", { exact: true })).toBeVisible();
  await dialog.getByRole("radio", { name: "不覆盖，保留已有款全部资料" }).check();
  await dialog.locator('input[type="file"]').setInputFiles({ ...file, name: "超过边界.xlsx" });
  await expect(dialog.getByText("请选择不超过 200 MB 的 .xlsx 文件", { exact: true })).toBeVisible();
  expect(state.previews).toHaveLength(0);
  await dialog.locator('input[type="file"]').setInputFiles({ ...file, name: "边界大小.xlsx" });
  await expect(dialog.getByText("新增 1 款，覆盖更新 0 款，不覆盖 1 款。", { exact: false })).toBeVisible();
  expect(state.previews).toHaveLength(1);
  expect(state.commits).toHaveLength(0);
});

test("5000款可以生成预览，5001款不发送预览请求", async ({ page }) => {
  const state = await fixture(page), dialog = await openImport(page);
  await dialog.getByRole("radio", { name: "不覆盖，保留已有款全部资料" }).check();
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("选款资料");
  sheet.addRow(["序缇款号", "长标题"]);
  for (let index = 1; index <= selectionImportLimits.maxRows; index++) sheet.addRow([`BULK-${index}`, `批量标题${index}`]);
  const file = async () => ({ name: "批量导入.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await book.xlsx.writeBuffer()) });
  await dialog.locator('input[type="file"]').setInputFiles(await file());
  await expect(dialog.getByText("新增 5000 款，覆盖更新 0 款，不覆盖 0 款。", { exact: false })).toBeVisible();
  expect(state.previews[0].rows).toHaveLength(selectionImportLimits.maxRows);
  sheet.addRow(["BULK-EXTRA", "超过上限"]);
  await dialog.locator('input[type="file"]').setInputFiles(await file());
  await expect(dialog.getByText(/每次导入最多 5000 款/)).toBeVisible();
  expect(state.previews).toHaveLength(1);
  await expect(dialog.getByRole("button", { name: "确认导入" })).toHaveCount(0);
  expect(state.commits).toHaveLength(0);
});

test("存在未保存修改时仍可进入导入弹窗下载模板，上传继续禁用", async ({ page }) => {
  const state = await fixture(page, false, false, 2);
  await page.locator('td[data-selection-column="custom:title"]').getByRole("textbox").fill("超过字数限制");
  const dialog = await openImport(page);
  await expect(dialog.getByText("请先处理表格中未保存的修改，再上传文件。", { exact: true })).toBeVisible();
  await expect(dialog.locator('input[type="file"]')).toBeDisabled();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: /下载模板$/ }).click();
  expect((await download).suggestedFilename()).toBe("选款登记导入模板.xlsx");
  expect(state.previews).toHaveLength(0);
  expect(state.commits).toHaveLength(0);
});

test("预览失败可重试，改变覆盖策略复用已上传的内嵌图片", async ({ page }) => {
  const state = await fixture(page, true), dialog = await openImport(page);
  await dialog.getByRole("radio", { name: "不覆盖，保留已有款全部资料" }).check();
  await dialog.locator('input[type="file"]').setInputFiles(await workbook(true));
  await expect.poll(() => state.previews.length).toBe(1);
  await expect(dialog.getByRole("radio", { name: "覆盖，仅更新本次填写的字段" })).toBeDisabled();
  await expect(dialog.locator('input[type="file"]')).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  state.releasePreview();
  await expect(dialog.getByText("字段已变化，请重新预览", { exact: true })).toBeVisible();
  expect(state.uploads).toHaveLength(1);
  await dialog.getByRole("button", { name: "重新预览" }).click();
  await expect(dialog.getByText("新增 0 款，覆盖更新 0 款，不覆盖 1 款。", { exact: false })).toBeVisible();
  await dialog.getByRole("radio", { name: "覆盖，仅更新本次填写的字段" }).check();
  await expect(dialog.getByRole("row").filter({ hasText: "IMPORT-001" })).toContainText("长标题、活动卖点、图片");
  expect(state.uploads).toHaveLength(1);
  expect(state.previews.every(body => body.rows[0].images[0].url === "/api/v1/style-selections/images/00111111-1111-4111-8111-111111111111")).toBe(true);
  await dialog.locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  expect(state.commits).toHaveLength(0);
});

test("部署过渡中的旧版预览不允许确认导入，重试新版预览后恢复", async ({ page }) => {
  const state = await fixture(page, false, true), dialog = await openImport(page);
  await dialog.getByRole("radio", { name: "不覆盖，保留已有款全部资料" }).check();
  await dialog.locator('input[type="file"]').setInputFiles(await workbook());
  await expect(dialog.getByText("导入服务正在更新，请刷新后重新预览", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认导入" })).toHaveCount(0);
  expect(state.commits).toHaveLength(0);
  await dialog.getByRole("button", { name: "重新预览" }).click();
  await expect(dialog.getByText("新增 1 款，覆盖更新 0 款，不覆盖 1 款。", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认导入" })).toBeVisible();
  await dialog.locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  expect(state.commits).toHaveLength(0);
});

test("Excel第3行吊牌价仅规范浮点尾差，真实三位小数显示单元格原值并阻止预览", async ({ page }) => {
  const state = await fixture(page), dialog = await openImport(page);
  await dialog.getByRole("radio", { name: "覆盖，仅更新本次填写的字段" }).check();
  const priceWorkbook = async (price: number) => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("选款资料");
    sheet.addRow(["序缇款号", "长标题", "吊牌价"]);
    sheet.addRow(["IMPORT-001", "第2行正常金额", 50]);
    sheet.addRow(["PRICE-003", "第3行数值金额", price]);
    return { name: "吊牌价检查.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await book.xlsx.writeBuffer()) };
  };
  for (const [price, expected] of [[0.1 + 0.2, "0.3"], [228.00000000000003, "228"]] as const) {
    const before = state.previews.length;
    await dialog.locator('input[type="file"]').setInputFiles(await priceWorkbook(price));
    await expect.poll(() => state.previews.length).toBe(before + 1);
    const row = state.previews.at(-1)!.rows[1];
    expect(row.xutiStyleNo).toBe("PRICE-003");
    expect(row.tagPrice).toBe(expected);
    await expect(dialog.getByRole("button", { name: "确认导入" })).toBeVisible();
  }
  const before = state.previews.length;
  await dialog.locator('input[type="file"]').setInputFiles(await priceWorkbook(1.005));
  const error = dialog.getByText(/第 3 行吊牌价应为非负金额，最多两位小数/);
  await expect(error).toBeVisible();
  await expect(error).toContainText("C3");
  await expect(error).toContainText("1.005");
  expect(state.previews).toHaveLength(before);
  await expect(dialog.getByRole("button", { name: "确认导入" })).toHaveCount(0);
  expect(state.commits).toHaveLength(0);
});

test("图片颜色错误定位实际Excel行和单元格，重新预览及更换文件保留正确位置", async ({ page }) => {
  const state = await fixture(page), dialog = await openImport(page);
  const rejected: Values[] = [];
  await page.route("**/api/v1/style-selections/import/preview", async route => {
    const body = route.request().postDataJSON();
    rejected.push(body);
    await route.fulfill({ status: 400, json: { error: {
      code: "VALIDATION_ERROR", message: "图片颜色必须来自颜色字段",
      details: { kind: "SELECTION_IMPORT_IMAGE_COLOR", rowIndex: 0, xutiStyleNo: "IMPORT-001", imageIndex: 1,
        imageSource: "import", colorSource: "import", imageColor: "红色", allowedColors: ["黑色", "白色"] },
    } } });
  });
  await dialog.getByRole("radio", { name: "覆盖，仅更新本次填写的字段" }).check();
  const file = async (inline: boolean) => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("选款资料");
    sheet.addRow(["供应商颜色", "图片", "序缇款号"]);
    const mainRow = inline ? 7 : 17;
    sheet.getCell(`A${mainRow}`).value = "黑色/白色";
    sheet.getCell(`C${mainRow}`).value = "IMPORT-001";
    if (inline) sheet.getCell(`B${mainRow}`).value = "黑色 | https://example.test/black.png\n红色 | https://example.test/red.png";
    else {
      const pictures = book.addWorksheet("图片明细");
      pictures.addRow(["序缇款号", "颜色", "图片URL"]);
      pictures.getRow(3).values = ["IMPORT-001", "黑色", "https://example.test/black.png"];
      pictures.getRow(29).values = ["IMPORT-001", "红色", "https://example.test/red.png"];
    }
    return { name: inline ? "主表图片颜色.xlsx" : "明细图片颜色.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await book.xlsx.writeBuffer()) };
  };
  await dialog.locator('input[type="file"]').setInputFiles(await file(false));
  const error = dialog.getByRole("alert");
  await expect(error).toContainText("图片明细第 29 行");
  await expect(error).toContainText("B29");
  await expect(error).toContainText("选款资料第 17 行");
  await expect(error).toContainText("A17");
  await expect(error).toContainText("IMPORT-001");
  await expect(error).toContainText("红色");
  await expect(error).toContainText("黑色、白色");
  await dialog.getByRole("button", { name: "重新预览" }).click();
  await expect.poll(() => rejected.length).toBe(2);
  await expect(error).toContainText("图片明细第 29 行");
  expect(rejected[0]).toEqual(rejected[1]);
  expect(Object.keys(rejected[0].rows[0]).sort()).toEqual(["color", "images", "xutiStyleNo"]);
  await dialog.locator('input[type="file"]').setInputFiles(await file(true));
  await expect(error).toContainText("选款资料第 7 行");
  await expect(error).toContainText("图片单元格 B7，第 2 行内容");
  await expect(error).toContainText("A7");
  await expect(error).not.toContainText("B29");
  await expect(dialog.getByRole("button", { name: "确认导入" })).toHaveCount(0);
  expect(state.commits).toHaveLength(0);
  expect(state.layoutWrites).toHaveLength(0);
});
