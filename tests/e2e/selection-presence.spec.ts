import { expect, test } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

test("selection presence uses toolbar cards while preserving private locations and moving cell markers", async ({
  page,
}) => {
  const preferences = selectionLayoutSchema.parse({ columns: [
    { key: "xutiStyleNo", label: "序缇款号", width: 140, type: "text" },
    { key: "supplierStyleNo", label: "供应商款号", width: 140, type: "text" },
  ] });
  const row = { id: "1", xutiStyleNo: "", supplierStyleNo: "", images: [], labelImages: [], extraFields: {}, updatedAt: "2026-10-11T00:00:00Z" };
  let peerCell: { editingId: string; editingColumn: string | null } | null = null;
  // The UI receives the same scoped/redacted presence shape as the real API;
  // this fixture checks rendering and publication, not database validation.
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "在线测试本人", csrfToken: "fixture", roleCodes: ["SUPER_ADMIN"], permissions: ["selection.read", "selection.manage"] };
    if (path.endsWith("/revision")) data = { revision: "presence-one" };
    if (path.endsWith("/sync")) data = { revision: "presence-one", index: [{ id: row.id, token: row.updatedAt }], data: [row] };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) data = { preferences, revision: 1, sharedPreferences: projectSelectionSharedLayout(preferences), sharedRevision: 1, canEditShared: true };
    if (path.endsWith("/presence")) data = request.method() === "POST" ? { ok: true } : [
      { userId: "101", displayName: "在线测试本人", activeAt: new Date().toISOString(), editingId: null, editingColumn: null },
      ...(peerCell ? [{
        userId: "999999",
        displayName: "协作测试员",
        activeAt: new Date().toISOString(),
        ...peerCell,
      }] : []),
    ];
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  const toolbar = page.locator(".selection-toolbar");
  const noPeers = toolbar.getByRole("button", {
    name: "在线协作者，0人",
    exact: true,
  });
  await expect(noPeers).toBeVisible();
  await expect(page.locator(".selection-card > .selection-collaborators")).toHaveCount(0);
  const card = page.getByRole("group", { name: "在线协作者卡片", exact: true });
  await noPeers.click();
  await expect(card).toContainText("暂无其他协作者在线");
  await noPeers.click();
  await expect(card).not.toBeVisible();
  const textCell = page
    .locator('td[data-selection-column="xutiStyleNo"]')
    .getByRole("textbox")
    .last();
  await expect(textCell).toBeVisible();
  const selected = page.waitForRequest(
    (request) =>
      request.url().endsWith("/style-selections/presence") &&
      request.method() === "POST" &&
      request.postDataJSON().editingId &&
      request.postDataJSON().editingColumn === "xutiStyleNo",
  );
  await textCell.click();
  peerCell = (await selected).postDataJSON();
  const marker = page.getByLabel("协作测试员正在选中此单元格", { exact: true });
  await expect(marker).toBeVisible({ timeout: 10000 });
  const onePeer = toolbar.getByRole("button", {
    name: "在线协作者，1人",
    exact: true,
  });
  await expect(onePeer).toBeVisible();
  await onePeer.click();
  await expect(card).toBeVisible();
  await expect(card).toContainText("协作测试员");
  await expect(card).not.toContainText("在线测试本人");
  await expect(card).toContainText("在线");
  await expect(card).toContainText("正在选中：未填款号 · 序缇款号");
  await expect(
    textCell.locator("xpath=ancestor::td").locator(".selection-remote-cell"),
  ).toHaveCount(1);
  peerCell = { ...peerCell!, editingColumn: "supplierStyleNo" };
  await expect(
    textCell.locator("xpath=ancestor::td").locator(".selection-remote-cell"),
  ).toHaveCount(0);
  await expect(marker).toBeVisible();
  await expect(card).toContainText("正在选中：未填款号 · 供应商款号");
  // A private field is redacted by the API. Its row must not be disclosed merely
  // because the heartbeat still contains editingId.
  peerCell = { ...peerCell!, editingColumn: null };
  await expect(marker).toHaveCount(0);
  await expect(card).toContainText("正在查看本表");
  await expect(card).not.toContainText("正在选中");
  await expect(card).not.toContainText("未填款号");
  await expect(card).not.toContainText("供应商款号");
  peerCell = null;
  await expect(marker).toHaveCount(0);
  await expect(noPeers).toBeVisible();
  await expect(card).toContainText("暂无其他协作者在线");
  await expect(card).not.toContainText("协作测试员");
});
