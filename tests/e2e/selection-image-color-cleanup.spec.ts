import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { defaultProtection } from "../../packages/contracts/src/selection-protection.js";
import { selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";

const standard = "custom:standard";
const columns: SelectionField[] = [
  { key: "images", label: "图片", width: 145, type: "image", imageConfig: { colors: true, links: true, upload: true, mobile: false, max: 30, autoplay: false } },
  { key: "xutiStyleNo", label: "序缇款号", width: 180, type: "text" },
  { key: "color", label: "供应商颜色", width: 160, type: "tags" },
  { key: standard, label: "标准颜色", width: 160, type: "tags", custom: true, ownerId: "11", visibility: "PUBLIC" },
  { key: "labelImages", label: "洗唛/吊牌图", width: 145, type: "image" },
];
const pictures = ["咖色", "咖色", "白色", "白色"].map((color, index) => ({ id: `photo-${index + 1}`, color,
  url: `https://cleanup.example.test/${index + 1}.svg`, ...(index > 1 ? { colorFieldKey: standard } : {}) }));

async function fixture(page: Page, conflict = false) {
  let revision = 1, layoutRevision = 0;
  let preferences = selectionLayoutSchema.parse({ columns, rowHeight: "normal", pageSize: 200, sort: "sortOrder", direction: "asc" });
  const rows: Record<string, any>[] = Array.from({ length: 4 }, (_, index) => ({
    id: String(index + 1), sortOrder: index + 1, xutiStyleNo: `XFW19-3178${index + 1}L`, color: "白色/咖色",
    images: structuredClone(pictures), labelImages: [{ id: "label", color: "", url: "https://cleanup.example.test/label.svg" }],
    extraFields: { [standard]: "白色/咖色" }, createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.001Z",
    defaultCellAccess: "edit", policyRevision: 0,
    cellAccess: Object.fromEntries(columns.map(field => [field.key, index === 1 && field.key === "images" ? "read" : index === 3 && field.key === standard ? "deny" : "edit"])),
    ...(index === 2 ? { migrationLocked: true } : {}), ...(index === 3 ? { hiddenCells: [standard] } : {}),
  }));
  const patches: Record<string, any>[] = [];
  await page.route("https://cleanup.example.test/**", route => route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="220"><rect width="180" height="220" fill="#f4ede5"/><path d="M65 25h50l35 30-20 30-14-12v120H64V73L50 85 30 55z" fill="#b9a28c"/><path d="M78 25q12 25 24 0" fill="none" stroke="#756252" stroke-width="4"/></svg>' }));
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "11", displayName: "图片整理验证", roleCodes: [], csrfToken: "fixture", permissions: ["selection.read", "selection.manage"] };
    if (path.endsWith("/layout-preferences")) {
      if (method === "POST") { preferences = selectionLayoutSchema.parse(request.postDataJSON().preferences); layoutRevision++; }
      data = { preferences, revision: layoutRevision, sharedPreferences: null, sharedRevision: 0, canEditShared: true };
    }
    if (path.endsWith("/revision")) data = { revision: `cleanup-${revision}` };
    if (path.endsWith("/sync")) data = { revision: `cleanup-${revision}`, index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/protection")) data = { settings: defaultProtection, revision: 0, canManage: false };
    if (/\/style-selections\/\d+$/u.test(path)) {
      const row = rows.find(row => row.id === path.split("/").at(-1))!;
      if (method === "PATCH") {
        const body = request.postDataJSON(); patches.push(body);
        if (conflict || body.expectedUpdatedAt !== row.updatedAt) return route.fulfill({ status: 409, json: { error: { code: "EDIT_CONFLICT", message: "记录已被其他人修改，请刷新后核对" } } });
        const { expectedUpdatedAt: _expectedUpdatedAt, ensureTrailingBlank: _ensureTrailingBlank, ...values } = body;
        Object.assign(row, values, { updatedAt: new Date(Date.UTC(2026, 9, 24) + ++revision).toISOString() });
      }
      data = row;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(4);
  return { rows, patches, changeColors() { rows[0].extraFields[standard] = "白色"; rows[0].updatedAt = new Date(Date.UTC(2026, 9, 24) + ++revision).toISOString(); } };
}

const imageCell = (page: Page, id = "1", field = "images") => page.locator(`td[data-selection-row="${id}"][data-selection-column="${field}"]`);
const preview = (page: Page) => page.getByRole("dialog", { name: "按标准颜色去重", exact: true });

test("preview and cancellation do not write; selected colour photographs save and can be undone", async ({ page }) => {
  const state = await fixture(page);
  await imageCell(page).getByRole("button", { name: "全部", exact: true }).click();
  const gallery = page.getByRole("dialog", { name: "全部图片 · 4 张", exact: true });
  await gallery.getByRole("button", { name: "按标准颜色去重", exact: true }).click();
  await expect(preview(page)).toContainText("标准颜色 2 种 · 当前 4 张 → 保留 2 张 · 移除 2 张");
  await preview(page).getByRole("button", { name: "取消", exact: true }).click();
  expect(state.patches).toHaveLength(0);
  await gallery.getByRole("button", { name: "按标准颜色去重", exact: true }).click();
  await preview(page).getByRole("radio", { name: /保留第 2 张（咖色）/u }).check();
  await preview(page).getByRole("radio", { name: /保留第 4 张（白色）/u }).check();
  await mkdir(".local", { recursive: true });
  await page.screenshot({ path: ".local/selection-image-color-cleanup-preview.png", fullPage: true });
  await preview(page).getByRole("button", { name: "确认移除 2 张", exact: true }).click();
  await expect.poll(() => state.rows[0].images.map((image: { id: string }) => image.id)).toEqual(["photo-2", "photo-4"]);
  expect(state.patches[0]).toHaveProperty("expectedUpdatedAt");
  expect(state.patches[0]).not.toHaveProperty("extraFields");
  expect(state.patches[0]).not.toHaveProperty("labelImages");
  await page.getByRole("dialog", { name: "全部图片 · 2 张" }).getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: /^撤销(?:\b|（|\s|$)/u }).click();
  await expect.poll(() => state.rows[0].images.length).toBe(4);
  await page.reload();
  await imageCell(page).getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "全部图片 · 4 张" })).toBeVisible();
});

test("read-only and locked cells cannot clean up; hidden standard colours and label photos are excluded", async ({ page }) => {
  const state = await fixture(page);
  for (const id of ["2", "3", "4"]) {
    await imageCell(page, id).getByRole("button", { name: "全部", exact: true }).click();
    const gallery = page.getByRole("dialog", { name: "全部图片 · 4 张" });
    const action = gallery.getByRole("button", { name: "按标准颜色去重", exact: true });
    if (id === "4") await expect(action).toBeDisabled(); else await expect(action).toHaveCount(0);
    await gallery.getByRole("button", { name: "关闭", exact: true }).click();
  }
  await imageCell(page, "1", "labelImages").getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.getByRole("button", { name: "按标准颜色去重", exact: true })).toHaveCount(0);
  expect(state.patches).toHaveLength(0);
});

test("a concurrent save conflict leaves stored images intact and shows the failure", async ({ page }) => {
  const state = await fixture(page, true);
  await imageCell(page).getByRole("button", { name: "全部", exact: true }).click();
  await page.getByRole("button", { name: "按标准颜色去重", exact: true }).click();
  await preview(page).getByRole("button", { name: "确认移除 2 张", exact: true }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.rows[0].images).toHaveLength(4);
  await page.getByRole("dialog", { name: "全部图片 · 2 张" }).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByText(/记录已被其他人修改，请刷新后核对/u).first()).toBeVisible();
});

test("changed colours invalidate the preview before any image write", async ({ page }) => {
  const state = await fixture(page);
  await imageCell(page).getByRole("button", { name: "全部", exact: true }).click();
  await page.getByRole("button", { name: "按标准颜色去重", exact: true }).click();
  state.changeColors();
  await expect(preview(page).getByText("图片或标准颜色已变化，请重新预览", { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(preview(page).getByRole("button", { name: /确认移除/u })).toBeDisabled();
  expect(state.patches).toHaveLength(0);
});
