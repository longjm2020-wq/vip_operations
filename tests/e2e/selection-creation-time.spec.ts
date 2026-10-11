import { expect, test, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { formatSelectionCreatedTime } from "../../packages/contracts/src/selection-created-time.js";

async function fixture(page: Page, entry: string, options: { count?: number; protectedSecondRow?: boolean; readonly?: boolean; systemColumns?: boolean } = {}) {
  // Dispose the prior app while its routes still exist. Page unload writes are
  // outside this regression and must never reach a locally running API.
  await page.goto("about:blank");
  await page.unroute("**/api/v1/**");
  await page.addInitScript(() => {
    let leaving = false;
    window.addEventListener("pagehide", () => { leaving = true; });
    const request = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if ((leaving || init?.keepalive) && String(input).includes("/api/v1/")) return Promise.resolve(new Response('{"data":null}', { headers: { "Content-Type": "application/json" } }));
      return request(input, init);
    };
  });
  const legacyColumns = [
    { key: "registrationBatch", label: "登记批次", width: 180, type: entry === "/products" ? "text" : "date" },
    { key: "xutiStyleNo", label: "序缇款号", width: 140, type: "text" },
    { key: "material", label: "材质", width: 140, type: "text" },
  ];
  if (options.systemColumns) legacyColumns.push(
    { key: "custom:creator", label: "创建人", width: 140, type: "creator", custom: true } as typeof legacyColumns[number],
    { key: "custom:created", label: "自动创建时间", width: 180, type: "createdTime", custom: true } as typeof legacyColumns[number],
    { key: "custom:modified", label: "最后修改时间", width: 180, type: "modifiedTime", custom: true } as typeof legacyColumns[number],
  );
  // Return a persisted old personal AND shared layout. The application's actual
  // snapshot parser must upgrade it, rather than the fixture pre-upgrading it.
  let preferences = { ...selectionLayoutSchema.parse({ columns: [], pageSize: options.count === 1000 ? 1000 : 20 }), columns: legacyColumns };
  let sharedPreferences = { ...projectSelectionSharedLayout(selectionLayoutSchema.parse(preferences)), columns: legacyColumns };
  let revision = 1, dataRevision = 0;
  const rows = Array.from({ length: options.count || 2 }, (_, index) => index + 1).map(id => ({
    id: String(id), xutiStyleNo: `CREATED-${id}`, registrationBatch: "2026-09-28", material: "棉",
    sortOrder: id, images: [], labelImages: [], extraFields: {},
    createdAt: id === 1 ? "2026-10-01T00:01:02Z" : "2026-10-03T02:03:04Z",
    updatedAt: "2026-10-11T00:00:00Z",
    createdBy: "101", createdByName: "创建时间测试", createdByUsername: "test",
    cellAccess: options.protectedSecondRow && id === 2 ? { registrationBatch: "read" } : {}, defaultCellAccess: "edit",
  }));
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "创建时间测试", csrfToken: "fixture", roleCodes: options.readonly ? [] : ["SUPER_ADMIN"], permissions: options.readonly ? ["selection.read", "product.read"] : ["selection.read", "selection.manage", "product.read", "product.manage"] };
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
  await expect(createdInput(page, 1)).toHaveValue("2026-10-01 08:01:02");
  return { rows, writes, display: () => selectionLayoutSchema.parse(preferences).columns.find(field => field.key === "registrationBatch")?.timeDisplay };
}

const createdCell = (page: Page, id: number) => page.locator(`td[data-selection-row="${id}"][data-selection-column="registrationBatch"]`);
const createdInput = (page: Page, id: number) => createdCell(page, id).locator("input,textarea");
const createdEditor = (page: Page) => page.getByRole("group", { name: "单元格编辑栏", exact: true }).getByRole("textbox", { name: "编辑创建时间", exact: true });
async function pasteTime(page: Page, text: string) {
  await createdCell(page, 1).evaluate((element, value) => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, text);
}
async function copyTimeColumn(page: Page) {
  await page.getByRole("columnheader", { name: "选择整列：创建时间", exact: true }).click();
  return page.locator(".selection-sheet table").evaluate(element => {
    const transfer = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: transfer }));
    return transfer.getData("text/plain").replace(/\r\n?/g, "\n");
  });
}

test("选款登记和商品档案升级旧批次布局，创建时间编辑后筛选、保存和刷新一致", async ({ page }) => {
  for (const entry of ["/style-selections", "/products"]) {
    const state = await fixture(page, entry);
    await expect(page.getByRole("columnheader", { name: "选择整列：创建时间", exact: true })).toBeVisible();
    await createdCell(page, 1).click();
    const editor = createdEditor(page);
    await expect(editor).toBeEditable();
    await expect(editor).toHaveValue("2026-10-01 08:01:02");
    await editor.fill("2026-10-02 10:30:45");
    await expect.poll(() => state.rows[0].createdAt).toBe("2026-10-02T02:30:45.000Z");
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toHaveProperty("createdAt", "2026-10-02T02:30:45.000Z");
    expect(state.writes[0]).not.toHaveProperty("registrationBatch");
    await expect(createdInput(page, 1)).toHaveValue("2026-10-02 10:30:45");
    const material = page.locator('td[data-selection-row="1"][data-selection-column="material"]').getByRole("textbox", { name: "材质", exact: true });
    await material.fill("羊毛");
    await expect.poll(() => state.rows[0].material).toBe("羊毛");
    expect(state.writes).toHaveLength(2);
    expect(state.writes[1]).not.toHaveProperty("registrationBatch");
    expect(state.writes[1]).not.toHaveProperty("createdAt");
    expect(state.rows[0].registrationBatch).toBe("2026-09-28");
    expect(state.rows[0].createdAt).toBe("2026-10-02T02:30:45.000Z");
    await expect(createdInput(page, 1)).toHaveValue("2026-10-02 10:30:45");

    await page.getByRole("button", { name: "筛选创建时间", exact: true }).click();
    const filter = page.locator(".selection-filter-panel:visible");
    await expect(filter.locator(".selection-filter-values")).toContainText("2026-10-02 10:30:45");
    await expect(filter.locator(".selection-filter-values")).not.toContainText("2026-09-28");
    await filter.getByRole("textbox", { name: "搜索筛选选项", exact: true }).fill("2026-10-02");
    await filter.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
    await page.reload();
    await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
    await expect(createdInput(page, 1)).toHaveValue("2026-10-02 10:30:45");
    await page.getByRole("button", { name: "筛选创建时间", exact: true }).click();
    await page.locator(".selection-filter-panel:visible").getByRole("button", { name: "清除筛选", exact: true }).click();
    await expect(page.locator("tr[data-selection-row]")).toHaveCount(2);
    await page.getByRole("textbox", { name: "搜索选款", exact: true }).fill("2026-10-03");
    await expect(page.locator("tr[data-selection-row]")).toHaveCount(1);
    await expect(createdInput(page, 2)).toHaveValue("2026-10-03 10:03:04");
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
    await expect(createdInput(page, 1)).toHaveValue("2026-10-02");
    expect(state.rows[0].registrationBatch).toBe("2026-09-28");
    expect(state.rows[0].createdAt).toBe("2026-10-02T02:30:45.000Z");
  }
});

test("创建时间保留未完成或无效输入，不能清空，修正后按北京时间保存", async ({ page }) => {
  const state = await fixture(page, "/style-selections");
  const input = createdInput(page, 1);
  await input.fill("2026-10-");
  await expect(createdCell(page, 1)).toHaveClass(/selection-cell-error/);
  await expect(page.getByRole("button", { name: "未保存 · 重试", exact: true })).toBeVisible();
  await expect(input).toHaveValue("2026-10-");
  expect(state.writes).toEqual([]);
  await input.fill("2026-02-29");
  await expect(createdCell(page, 1)).toHaveAttribute("title", /有效的北京时间/);
  await createdCell(page, 1).click();
  await createdEditor(page).fill("");
  await expect(createdCell(page, 1)).toHaveAttribute("title", /不能为空/);
  expect(state.rows[0].createdAt).toBe("2026-10-01T00:01:02Z");
  await createdEditor(page).fill("2026-10-02");
  await expect.poll(() => state.rows[0].createdAt).toBe("2026-10-01T16:00:00.000Z");
  await expect(input).toHaveValue("2026-10-02 00:00:00");
  await expect(createdCell(page, 1)).not.toHaveClass(/selection-cell-error/);
  expect(state.writes).toHaveLength(1);
  expect(state.rows[0].registrationBatch).toBe("2026-09-28");
});

test("创建时间批量粘贴遵守区域和只读权限，自建系统列继续只读", async ({ page }) => {
  const state = await fixture(page, "/style-selections", { protectedSecondRow: true, systemColumns: true });
  await pasteTime(page, "2026-10-02 10:30\n2026-10-04");
  await expect.poll(() => state.rows[0].createdAt).toBe("2026-10-02T02:30:00.000Z");
  await expect(createdInput(page, 2)).not.toBeEditable();
  expect(state.rows[1].createdAt).toBe("2026-10-03T02:03:04Z");
  expect(state.writes).toHaveLength(1);
  for (const key of ["custom:creator", "custom:created", "custom:modified"]) {
    const cell = page.locator(`td[data-selection-row="1"][data-selection-column="${key}"]`);
    await expect(cell.locator("input,textarea")).toHaveCount(0);
  }
  const readonly = await fixture(page, "/style-selections", { readonly: true });
  await expect(createdInput(page, 1)).not.toBeEditable();
  await pasteTime(page, "2026-10-05\n2026-10-06");
  await expect(createdInput(page, 1)).toHaveValue("2026-10-01 08:01:02");
  expect(readonly.writes).toEqual([]);
});

test("1000行创建时间整列复制和多行粘贴包括未挂载行，保存后刷新一致", async ({ page }) => {
  test.setTimeout(120000);
  const state = await fixture(page, "/style-selections", { count: 1000 });
  const original = (await copyTimeColumn(page)).split("\n");
  expect(original).toHaveLength(1000);
  expect(original[0]).toBe("2026-10-01 08:01:02");
  expect(original.at(-1)).toBe("2026-10-03 10:03:04");
  const values = Array.from({ length: 1000 }, (_, index) => `2027-01-02 12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`);
  await pasteTime(page, values.join("\r\n"));
  expect((await copyTimeColumn(page)).split("\n")).toEqual(values);
  await expect.poll(() => state.writes.length, { timeout: 90000 }).toBe(1000);
  expect(state.rows.map(row => formatSelectionCreatedTime(row.createdAt))).toEqual(values);
  expect(state.writes.every(body => typeof body.createdAt === "string" && !Object.prototype.hasOwnProperty.call(body, "registrationBatch"))).toBe(true);
  expect(state.rows.every(row => row.registrationBatch === "2026-09-28")).toBe(true);
  await page.reload();
  await expect(createdInput(page, 1)).toHaveValue(values[0]);
  expect((await copyTimeColumn(page)).split("\n")).toEqual(values);
});
