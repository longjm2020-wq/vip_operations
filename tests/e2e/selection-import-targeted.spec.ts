import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

type Values = Record<string, any>;
async function workbook(image = false) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("选款资料");
  sheet.addRow(["创建时间", "序缇款号", "长标题", "活动卖点", "唯品价", ...(image ? ["图片"] : [])]);
  sheet.addRow(["1999-01-01", "IMPORT-001", "本次更新标题", "新品上市", "", ...(image ? ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="] : [])]);
  if (!image) sheet.addRow(["", "IMPORT-002", "新增款标题", "新品上市"]);
  return { name: "针对性更新.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await book.xlsx.writeBuffer()) };
}

async function fixture(page: Page, failFirstPreview = false, legacyFirstPreview = false) {
  let preferences = selectionLayoutSchema.parse({ columns: [
    { key: "registrationBatch", label: "创建时间", type: "createdTime" },
    { key: "xutiStyleNo", label: "序缇款号", type: "text" },
    { key: "color", label: "供应商颜色", type: "tags" },
    { key: "custom:title", label: "长标题", type: "text", custom: true, visibility: "PUBLIC" },
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
