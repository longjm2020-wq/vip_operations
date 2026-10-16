import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { projectSelectionSharedLayout, selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";

type Row = Record<string, any>;
const noteKey = "custom:history-note";
const columns: SelectionField[] = [
  { key: "xutiStyleNo", label: "序缇款号", type: "text", width: 170 },
  { key: "material", label: "成分", type: "text", width: 180 },
  { key: noteKey, label: "历史备注", type: "text", width: 180, custom: true, ownerId: "101", visibility: "PUBLIC", fieldRevision: 1 },
];

async function fixture(page: Page, count = 3, path = "/style-selections", options: { syncDelayMs?: number } = {}) {
  let dataRevision = 1, layoutRevision = 1, nextId = 100, syncRequests = 0, syncResponses = 0;
  let preferences = selectionLayoutSchema.parse({ columns, rowHeight: "compact", pageSize: 200, sort: "sortOrder", direction: "asc" });
  const records: Row[] = Array.from({ length: count + 1 }, (_, index) => ({
    id: String(index + 1), sortOrder: index + 1,
    xutiStyleNo: index === count ? "" : `HISTORY-${index + 1}`,
    material: index === count ? "" : `原成分${index + 1}`,
    extraFields: { [noteKey]: index === count ? "" : `原备注${index + 1}` },
    images: [], labelImages: [], cellColors: {}, cellAlignments: {}, cellTextColors: {},
    createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.001Z",
    defaultCellAccess: "edit", policyRevision: 0,
  }));
  const receipts = new Map<string, Row>();
  const calls: { path: string; method: string; body: Row | undefined }[] = [];
  const stamp = () => new Date(Date.UTC(2026, 9, 16) + ++dataRevision).toISOString();
  const current = (id: string) => records.find(row => row.id === id)!;
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), apiPath = new URL(request.url()).pathname;
    const method = request.method(), body = request.postData() ? request.postDataJSON() as Row : undefined;
    const error = (message: string, code = "EDIT_CONFLICT") => route.fulfill({ status: 409, json: { error: { code, message } } });
    let data: unknown = [];
    if (apiPath.endsWith("/auth/me")) data = { id: "101", displayName: "历史测试", roleCodes: ["SUPER_ADMIN"], csrfToken: "fixture", permissions: ["selection.read", "selection.manage", "product.read", "product.update", "product.create", "project.read", "project.create"] };
    if (apiPath.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: true, canManage: true };
    if (apiPath.endsWith("/project-tables/7")) data = { id: "7", name: "历史协作表", initialLayout: "selection", canEdit: true, canManage: true };
    if (apiPath.endsWith("/revision")) data = { revision: `history-${dataRevision}` };
    if (apiPath.endsWith("/sync")) {
      // Capture the authorized response at request time. Later mutations must
      // not change the delayed snapshot already being returned by the server.
      data = structuredClone({ revision: `history-${dataRevision}`, index: records.map(row => ({ id: row.id, token: row.updatedAt })), data: records });
      if (syncRequests++ > 0 && options.syncDelayMs)
        await new Promise(resolve => setTimeout(resolve, options.syncDelayMs));
      await route.fulfill({ json: { data } }); syncResponses++;
      return;
    }
    if (apiPath.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (apiPath.endsWith("/protection")) data = { settings: defaultProtection, revision: 0, canManage: false };
    if (apiPath.endsWith("/layout-preferences")) {
      if (method === "POST") {
        calls.push({ path: apiPath, method, body });
        if (body!.revision !== layoutRevision) return error("其他人已更新布局");
        preferences = selectionLayoutSchema.parse(body!.preferences);
        layoutRevision++;
      }
      data = { preferences, revision: layoutRevision, sharedPreferences: projectSelectionSharedLayout(preferences), sharedRevision: layoutRevision, canEditShared: true };
    }
    if (apiPath.endsWith("/history/delete-rows") && method === "POST") {
      calls.push({ path: apiPath, method, body });
      if (body!.rows.some((row: Row) => !current(row.id) || current(row.id).updatedAt !== row.expectedUpdatedAt)) return error("选中行已被其他人修改，本次未删除任何行");
      const deletions = body!.rows.map((row: Row) => {
        const token = randomUUID();
        receipts.set(`${row.id}:${token}`, structuredClone(current(row.id)));
        return { rowId: row.id, token };
      });
      for (const deletion of deletions) records.splice(records.findIndex(row => row.id === deletion.rowId), 1);
      dataRevision++;
      data = { deletions };
    } else if (apiPath.endsWith("/history/restore-rows") && method === "POST") {
      calls.push({ path: apiPath, method, body });
      if (body!.deletions.some((deletion: Row) => current(deletion.rowId) || !receipts.has(`${deletion.rowId}:${deletion.token}`))) return error("删除记录已失效", "HISTORY_EXPIRED");
      const restored = body!.deletions.map((deletion: Row) => {
        const key = `${deletion.rowId}:${deletion.token}`;
        const row = { ...structuredClone(receipts.get(key)!), updatedAt: stamp() };
        receipts.delete(key); records.push(row); return row;
      });
      records.sort((a, b) => a.sortOrder - b.sortOrder);
      data = { rows: restored };
    } else if (apiPath.endsWith("/style-selections") && method === "POST") {
      calls.push({ path: apiPath, method, body });
      const { ensureTrailingBlank: _ensureTrailingBlank, expectedUpdatedAt: _expectedUpdatedAt, ...values } = body!;
      const row = { ...values, id: String(nextId++), createdAt: stamp(), updatedAt: stamp(), defaultCellAccess: "edit", policyRevision: 0 };
      records.push(row); data = row;
    } else if (/\/style-selections\/\d+$/u.test(apiPath)) {
      const id = apiPath.split("/").at(-1)!, row = current(id);
      if (method === "PATCH") {
        calls.push({ path: apiPath, method, body });
        if (!row || body!.expectedUpdatedAt !== row.updatedAt) return error("其他人已修改此记录，请刷新后核对");
        const { expectedUpdatedAt: _expectedUpdatedAt, ensureTrailingBlank: _ensureTrailingBlank, ...values } = body!;
        const maps: Row = { extraFields: { ...row.extraFields, ...values.extraFields } };
        for (const key of ["cellColors", "cellAlignments", "cellVerticalAlignments", "cellTextColors", "cellNumberFormats"]) {
          maps[key] = { ...row[key] };
          for (const [field, value] of Object.entries(values[key] || {})) {
            if (value === null) delete maps[key][field]; else maps[key][field] = value;
          }
        }
        Object.assign(row, values, maps, { updatedAt: stamp() }); data = row;
      } else if (method === "DELETE") {
        calls.push({ path: apiPath, method, body });
        if (!row) return error("记录已被删除");
        const token = randomUUID(); receipts.set(`${id}:${token}`, structuredClone(row));
        records.splice(records.indexOf(row), 1); dataRevision++; data = { id, token };
      } else data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(path);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(count + 1);
  return { records, calls, current, preferences: () => preferences, syncResponses: () => syncResponses,
    remoteEdit(id: string, values: Row) { Object.assign(current(id), values, { updatedAt: stamp() }); },
    remoteLayout(update: (value: typeof preferences) => typeof preferences) { preferences = update(preferences); layoutRevision++; },
  };
}

const cell = (page: Page, id: string, key = "material") => page.locator(`td[data-selection-row="${id}"][data-selection-column="${key}"]`);
const header = (page: Page, key: string) => page.locator(`th[data-selection-column="${key}"]`);
const undo = (page: Page) => page.getByRole("button", { name: /^撤销(?:\b|（|\s|$)/u });
const redo = (page: Page) => page.getByRole("button", { name: /^重做(?:\b|（|\s|$)/u });
const editor = (page: Page, id: string, key = "material") => cell(page, id, key).locator("textarea,input").first();
async function edit(page: Page, id: string, value: string, key = "material") {
  await editor(page, id, key).fill(value);
  await header(page, "xutiStyleNo").click();
}
async function paste(target: Locator, text: string) {
  await target.click();
  await target.evaluate((element, value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, text);
}
async function refreshFromServer(page: Page) { await page.evaluate(() => window.dispatchEvent(new Event("online"))); }

for (const [label, path] of [["选款登记", "/style-selections"], ["商品档案", "/products"], ["协作表格", "/project-tables/7"]]) {
  test(`${label}单元格撤销重做按原值保存，撤销后新修改清除重做`, async ({ page }) => {
    const state = await fixture(page, 3, path);
    await expect(undo(page)).toBeDisabled(); await expect(redo(page)).toBeDisabled();
    await edit(page, "1", "修改成分");
    await expect.poll(() => state.current("1").material).toBe("修改成分");
    await expect(undo(page)).toBeEnabled();
    await undo(page).click();
    await expect(editor(page, "1")).toHaveValue("原成分1");
    await expect.poll(() => state.current("1").material).toBe("原成分1");
    await redo(page).click();
    await expect.poll(() => state.current("1").material).toBe("修改成分");
    await undo(page).click();
    await expect.poll(() => state.current("1").material).toBe("原成分1");
    await edit(page, "2", "新的操作");
    await expect.poll(() => state.current("2").material).toBe("新的操作");
    await expect(redo(page)).toBeDisabled();
    expect(state.current("1").extraFields[noteKey]).toBe("原备注1");
    expect(state.calls.filter(call => call.method === "PATCH").every(call => typeof call.body?.expectedUpdatedAt === "string")).toBe(true);
    await page.reload();
    await expect(editor(page, "2")).toHaveValue("新的操作");
    await expect(undo(page)).toBeDisabled(); await expect(redo(page)).toBeDisabled();
  });
}

test("矩形粘贴、清空与格式各为一步，撤销保留未涉及单元格", async ({ page }) => {
  const state = await fixture(page);
  await paste(cell(page, "1"), "新成分1\t新备注1\n新成分2\t新备注2");
  await expect.poll(() => state.current("2").extraFields[noteKey]).toBe("新备注2");
  await undo(page).click();
  await expect.poll(() => [state.current("1").material, state.current("1").extraFields[noteKey], state.current("2").material, state.current("2").extraFields[noteKey]])
    .toEqual(["原成分1", "原备注1", "原成分2", "原备注2"]);
  await expect(undo(page)).toBeDisabled();
  await redo(page).click();
  await expect.poll(() => state.current("2").extraFields[noteKey]).toBe("新备注2");
  await cell(page, "1").click(); await cell(page, "1").press("Delete");
  await expect.poll(() => state.current("1").material || "").toBe("");
  await undo(page).click();
  await expect.poll(() => state.current("1").material).toBe("新成分1");
  await cell(page, "1").click();
  await page.getByRole("button", { name: "右对齐", exact: true }).click();
  await expect.poll(() => state.current("1").cellAlignments?.material).toBe("right");
  await undo(page).click();
  await expect.poll(() => state.current("1").cellAlignments?.material).toBeUndefined();
  await expect.poll(() => state.current("1").material).toBe("新成分1");
  await redo(page).click();
  await expect.poll(() => state.current("1").cellAlignments?.material).toBe("right");
  expect(state.current("3").material).toBe("原成分3");
});

test("查找全部替换作为一步撤销并重做，不逐格消耗历史", async ({ page }) => {
  const state = await fixture(page);
  await header(page, "material").click(); await page.keyboard.press("Control+h");
  const dialog = page.getByRole("dialog", { name: "查找/替换", exact: true });
  await dialog.getByLabel("查找内容", { exact: true }).fill("原成分");
  await dialog.getByLabel("替换为", { exact: true }).fill("新成分");
  await dialog.getByRole("button", { name: /全部替换$/u }).click();
  await expect.poll(() => state.records.filter(row => String(row.material).startsWith("新成分")).length).toBe(3);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await undo(page).click();
  await expect.poll(() => state.records.filter(row => String(row.material).startsWith("原成分")).length).toBe(3);
  await expect(undo(page)).toBeDisabled();
  await redo(page).click();
  await expect.poll(() => state.records.filter(row => String(row.material).startsWith("新成分")).length).toBe(3);
});

test("新增和删除行可撤销重做，使用删除凭据恢复完整已保存行", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: /添加一行$/u }).first().click();
  await expect.poll(() => state.records.length).toBe(5);
  const addedId = state.records.find(row => row.id === "100")!.id;
  await undo(page).click();
  await expect.poll(() => state.records.some(row => row.id === addedId)).toBe(false);
  await redo(page).click();
  await expect.poll(() => state.records.some(row => row.id === addedId)).toBe(true);
  await page.getByRole("checkbox", { name: "选择 HISTORY-2", exact: true }).check();
  const saved = structuredClone(state.current("2"));
  await page.getByRole("button", { name: /删除行$/u }).click();
  await expect.poll(() => state.records.some(row => row.id === "2")).toBe(false);
  await undo(page).click();
  await expect.poll(() => state.records.some(row => row.id === "2")).toBe(true);
  expect(state.current("2")).toMatchObject({ id: saved.id, material: saved.material, extraFields: saved.extraFields, images: saved.images, createdAt: saved.createdAt });
  const restores = state.calls.filter(call => call.path.endsWith("/history/restore-rows"));
  expect(restores.length).toBeGreaterThanOrEqual(2);
  expect(restores.every(call => call.body?.deletions.every((deletion: Row) => Object.keys(deletion).sort().join(",") === "rowId,token"))).toBe(true);
  await redo(page).click();
  await expect.poll(() => state.records.some(row => row.id === "2")).toBe(false);
});

test("延迟同步时恢复新增行保留原本地标识，再次撤销仍能删除正确行", async ({ page }) => {
  const state = await fixture(page, 3, "/style-selections", { syncDelayMs: 350 });
  await page.getByRole("button", { name: /添加一行$/u }).first().click();
  await expect.poll(() => state.records.some(row => row.id === "100")).toBe(true);
  const originalKey = await page.locator("tr[data-selection-row]").last().getAttribute("data-selection-row");
  expect(originalKey).toBeTruthy(); expect(originalKey).not.toBe("100");
  await expect(undo(page)).toBeEnabled();
  const beforeDeleteSync = state.syncResponses();
  await undo(page).click();
  await expect.poll(() => state.records.some(row => row.id === "100")).toBe(false);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(4);
  await expect.poll(() => state.syncResponses()).toBeGreaterThan(beforeDeleteSync);
  await expect(redo(page)).toBeEnabled();
  const beforeRestoreSync = state.syncResponses();
  await redo(page).click();
  await expect.poll(() => state.records.some(row => row.id === "100")).toBe(true);
  await expect.poll(() => state.syncResponses()).toBeGreaterThan(beforeRestoreSync);
  // Let React consume the delayed response before checking retained identity.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator(`tr[data-selection-row="${originalKey}"]`)).toHaveCount(1);
  await expect(page.locator('tr[data-selection-row="100"]')).toHaveCount(0);
  await expect(undo(page)).toBeEnabled();
  await undo(page).click();
  await expect.poll(() => state.records.some(row => row.id === "100")).toBe(false);
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(4);
  const deletes = state.calls.filter(call => call.path.endsWith("/history/delete-rows"));
  expect(deletes).toHaveLength(2);
  expect(deletes.every(call => call.body?.rows.length === 1 && call.body.rows[0].id === "100")).toBe(true);
});

test("字段新增删除与列宽调整共用操作顺序并保留原字段内容", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "添加字段", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加字段", exact: true });
  await dialog.getByLabel("字段名称", { exact: true }).fill("历史新增字段");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => state.preferences().columns.some(field => field.label === "历史新增字段" && !field.deleted)).toBe(true);
  const newKey = state.preferences().columns.find(field => field.label === "历史新增字段")!.key;
  await undo(page).click(); await expect(header(page, newKey)).toHaveCount(0);
  await redo(page).click(); await expect(header(page, newKey)).toBeVisible();
  await header(page, "material").click({ button: "right" });
  await page.getByRole("menu", { name: "列操作：成分", exact: true }).getByRole("menuitem", { name: "设置列宽", exact: true }).click();
  const widthDialog = page.getByRole("dialog", { name: "设置列宽", exact: true });
  await widthDialog.getByRole("spinbutton", { name: "列宽数值", exact: true }).fill("260");
  await widthDialog.getByRole("button", { name: "确定", exact: true }).click();
  await expect.poll(() => state.preferences().columns.find(field => field.key === "material")!.width).toBe(260);
  await undo(page).click(); await expect(header(page, "material")).toHaveCSS("width", "180px");
  await redo(page).click(); await expect(header(page, "material")).toHaveCSS("width", "260px");
  await page.getByRole("button", { name: "字段管理", exact: true }).click();
  await page.getByRole("button", { name: "删除字段历史备注", exact: true }).click();
  await page.getByRole("dialog", { name: "删除字段“历史备注”？", exact: true }).getByRole("button", { name: "删除字段", exact: true }).click();
  await expect(header(page, noteKey)).toHaveCount(0);
  await undo(page).click();
  await expect(header(page, noteKey)).toBeVisible();
  await expect(editor(page, "1", noteKey)).toHaveValue("原备注1");
  await redo(page).click(); await expect(header(page, noteKey)).toHaveCount(0);
  expect(state.current("1").extraFields[noteKey]).toBe("原备注1");
});

test("最多撤销十步，超过十步只丢弃最早的一步", async ({ page }) => {
  test.setTimeout(120000);
  const state = await fixture(page, 12);
  for (let index = 1; index <= 11; index++) {
    await edit(page, String(index), `第${index}步修改`);
    await expect.poll(() => state.current(String(index)).material).toBe(`第${index}步修改`);
  }
  for (let index = 11; index >= 2; index--) {
    await undo(page).click();
    await expect.poll(() => state.current(String(index)).material).toBe(`原成分${index}`);
  }
  await expect(undo(page)).toBeDisabled();
  expect(state.current("1").material).toBe("第1步修改");
  await redo(page).click();
  await expect.poll(() => state.current("2").material).toBe("第2步修改");
});

test("多人修改过的单元格不会被历史覆盖，拒绝撤销不消耗步骤", async ({ page }) => {
  const state = await fixture(page);
  await edit(page, "1", "本人修改");
  await expect.poll(() => state.current("1").material).toBe("本人修改");
  state.remoteEdit("1", { material: "其他人最新内容" });
  await refreshFromServer(page);
  await expect(editor(page, "1")).toHaveValue("其他人最新内容");
  const patchCount = state.calls.filter(call => call.method === "PATCH").length;
  await undo(page).click();
  await expect(page.getByText(/(?:历史|撤销).*(?:冲突|变化|修改)|(?:其他人|其他用户|他人).*修改/u).last()).toBeVisible();
  expect(state.current("1").material).toBe("其他人最新内容");
  expect(state.calls.filter(call => call.method === "PATCH")).toHaveLength(patchCount);
  await expect(undo(page)).toBeEnabled(); await expect(redo(page)).toBeDisabled();
});

test("新增行保存后已有同事填写，撤销新增拒绝删除并保留历史", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: /添加一行$/u }).first().click();
  await expect.poll(() => state.records.some(row => row.id === "100")).toBe(true);
  const addedRow = page.locator("tr[data-selection-row]").last();
  const addedKey = await addedRow.getAttribute("data-selection-row");
  expect(addedKey).toBeTruthy();
  state.remoteEdit("100", { material: "同事已填写的成分" });
  await refreshFromServer(page);
  await expect(editor(page, addedKey!)).toHaveValue("同事已填写的成分");
  const deleteCount = state.calls.filter(call => call.path.endsWith("/history/delete-rows")).length;
  await undo(page).click();
  await expect(page.getByText(/相关行内容已被后续操作修改，不能删除/u)).toBeVisible();
  expect(state.current("100").material).toBe("同事已填写的成分");
  expect(state.records).toHaveLength(5);
  expect(state.calls.filter(call => call.path.endsWith("/history/delete-rows"))).toHaveLength(deleteCount);
  await expect(undo(page)).toBeEnabled();
  await expect(redo(page)).toBeDisabled();
});

test("同事修改另一单元格后，撤销只还原本人单元格并保留同事内容", async ({ page }) => {
  const state = await fixture(page);
  await edit(page, "1", "本人改过的成分");
  await expect.poll(() => state.current("1").material).toBe("本人改过的成分");
  state.remoteEdit("1", { extraFields: { ...state.current("1").extraFields, [noteKey]: "同事最新备注" } });
  await refreshFromServer(page);
  await expect(editor(page, "1", noteKey)).toHaveValue("同事最新备注");
  await expect(editor(page, "1")).toHaveValue("本人改过的成分");
  const beforeUndo = state.calls.length;
  await undo(page).click();
  await expect.poll(() => state.current("1").material).toBe("原成分1");
  await expect(editor(page, "1", noteKey)).toHaveValue("同事最新备注");
  expect(state.current("1").extraFields[noteKey]).toBe("同事最新备注");
  const undoPatches = state.calls.slice(beforeUndo).filter(call => call.method === "PATCH");
  expect(undoPatches).toHaveLength(1);
  expect(undoPatches[0].body).toMatchObject({ material: "原成分1" });
  expect(undoPatches[0].body).not.toHaveProperty("extraFields");
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toBeEnabled();
});

test("表头聚焦时CtrlZ撤销、CtrlShiftZ和CtrlY重做", async ({ page }) => {
  const state = await fixture(page);
  await edit(page, "1", "键盘修改成分");
  await expect.poll(() => state.current("1").material).toBe("键盘修改成分");
  await expect(undo(page)).toBeEnabled();
  await header(page, "material").focus(); await page.keyboard.press("Control+z");
  await expect.poll(() => state.current("1").material).toBe("原成分1");
  await expect(redo(page)).toBeEnabled();
  await header(page, "material").focus(); await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => state.current("1").material).toBe("键盘修改成分");
  await expect(undo(page)).toBeEnabled();
  await header(page, "material").focus(); await page.keyboard.press("Control+z");
  await expect.poll(() => state.current("1").material).toBe("原成分1");
  await expect(redo(page)).toBeEnabled();
  await header(page, "material").focus(); await page.keyboard.press("Control+y");
  await expect.poll(() => state.current("1").material).toBe("键盘修改成分");
  expect(state.current("2").material).toBe("原成分2");
});

test("文本输入中的CtrlZ与重做沿用浏览器原生行为，不撤销其他单元格", async ({ page }) => {
  const state = await fixture(page);
  await edit(page, "1", "已有的其他单元格操作");
  await expect.poll(() => state.current("1").material).toBe("已有的其他单元格操作");
  const native = editor(page, "2");
  await native.dblclick(); await native.press("End");
  await native.evaluate(element => element.addEventListener("keydown", event => {
    if ((event as KeyboardEvent).ctrlKey && ["z", "y"].includes((event as KeyboardEvent).key.toLowerCase()))
      (element as HTMLElement).dataset.historyNativePrevented = String(event.defaultPrevented);
  }));
  // Browser undo groups can differ by typing cadence; one trusted character
  // gives an exact native undo boundary without assuming a whole-word group.
  await native.pressSequentially("Z");
  await expect(native).toHaveValue("原成分2Z");
  await native.press("Control+z");
  await expect(native).toHaveAttribute("data-history-native-prevented", "false");
  await expect(native).toHaveValue("原成分2");
  expect(state.current("1").material).toBe("已有的其他单元格操作");
  await native.press("Control+Shift+z");
  await expect(native).toHaveValue("原成分2Z");
  await native.press("Control+z"); await native.press("Control+y");
  await expect(native).toHaveValue("原成分2Z");
  await expect(native).toHaveAttribute("data-history-native-prevented", "false");
  expect(state.current("1").material).toBe("已有的其他单元格操作");
});
