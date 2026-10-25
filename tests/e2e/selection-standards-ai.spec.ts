import { expect, test, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

type Values = Record<string, any>;
async function fixture(page: Page, options: { count?: number; readonly?: boolean; configured?: boolean; failSecondSave?: boolean; pauseFirst?: boolean; conditional?: boolean; unverified?: boolean } = {}) {
  await page.addInitScript(() => {
    const request = window.fetch.bind(window);
    window.fetch = (input, init) => init?.keepalive && String(input).includes("/api/v1/") ? Promise.resolve(new Response('{"data":null}', { headers: { "Content-Type": "application/json" } })) : request(input, init);
  });
  const preferences = selectionLayoutSchema.parse({ columns: [
    { key: "registrationBatch", label: "创建时间", type: "createdTime" },
    { key: "xutiStyleNo", label: "序缇款号", type: "text" },
    { key: "material", label: "成分", type: "text" },
    { key: "custom:category", label: "三级类目", type: "text", custom: true },
    { key: "custom:title", label: "长标题", type: "text", custom: true },
    { key: "custom:safety", label: "安全类别", type: "text", custom: true },
    { key: "custom:standard", label: "执行标准", type: "text", custom: true },
  ] });
  const rows: Values[] = Array.from({ length: options.count ?? 3 }, (_, index) => ({
    id: String(index + 1), xutiStyleNo: `ST-${index + 1}`, material: "面料：棉100%，梭织；无填充", registrationBatch: "2026-10-24T00:00:00Z", createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z", images: [], labelImages: [],
    extraFields: { "custom:category": "女式外套", "custom:title": "女式梭织夹克外套", "custom:safety": index === 0 ? "已有安全类别" : "", "custom:standard": "" },
  }));
  let revision = 1, release: (() => void) | undefined;
  const generations: Values[] = [], applies: Values[] = [], gridWrites: Values[] = [], idempotencyKeys: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "适配测试", csrfToken: "fixture", roleCodes: [], permissions: options.readonly ? ["product.read"] : ["selection.read", "selection.manage", "selection.protect", "product.read", "product.manage", "setting.manage"] };
    if (path.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: !options.readonly, canManage: !options.readonly };
    if (path.endsWith("/revision")) data = { revision: String(revision) };
    if (path.endsWith("/sync")) data = { revision: String(revision), index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) data = { preferences, revision: 1, sharedPreferences: projectSelectionSharedLayout(preferences), sharedRevision: 1, canEditShared: !options.readonly };
    if (path.endsWith("/ai-standards/status")) data = { ready: options.configured !== false, message: options.configured === false ? "请先验证 AI 模型" : "已就绪" };
    if (path.endsWith("/ai-standards/generate")) {
      const body = request.postDataJSON(); generations.push(body);
      if (options.pauseFirst && generations.length === 1) await new Promise<void>(resolve => { release = resolve; });
      data = { planToken: `standards-fixture-token-${generations.length}-abcdefghijklmnop`, expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), model: "fixture-model", catalogCheckedAt: "2026-10-24", warnings: [],
        rows: body.rowIds.map((id: string) => {
          const row = rows.find(row => row.id === id)!;
          return { id, xutiStyleNo: row.xutiStyleNo, evidence: ["实际读取：商品图片 1 张", "成分：棉100%，梭织", "三级类目：女式外套"], warnings: [],
            values: body.targetKeys.filter((key: string) => body.mode === "replace" || !row.extraFields[key]).map((key: string) => ({ key, label: key === "custom:safety" ? "安全类别" : "执行标准", previousValue: row.extraFields[key] || "",
              value: options.unverified || id === "3" && key === "custom:standard" ? "" : key === "custom:safety" ? "GB 18401-2010 C类" : "FZ/T 81007-2022", reason: id === "3" && key === "custom:standard" ? "关键商品资料互相矛盾，无法确定优先标准" : options.conditional ? "根据类目与款式优先建议，需核对具体适用条件" : "成人非贴身梭织夹克，无填充",
              ...(options.unverified ? { candidateValue: "QB/T 1615-2018", verification: { status: "unavailable", message: "官方标准核验服务暂不可用，已保留 AI 分析；请稍后重新适配，无需补填商品资料", checkedAt: "2026-10-25T02:00:00Z" } } : {}),
              checks: options.conditional ? ["核对主面料为机织结构", "核对是否有保暖填充"] : [],
              source: options.unverified || id === "3" && key === "custom:standard" ? null : { name: "单、夹服装", url: "https://std.samr.gov.cn/hb/search/stdHBDetailed?id=F9A74BF1D2B7EC70E05397BE0A0A8DAE" },
            })),
          };
        }),
      };
    }
    if (path.endsWith("/ai-standards/apply")) {
      const body = request.postDataJSON(); applies.push(body); idempotencyKeys.push(request.headers()["idempotency-key"]);
      if (options.failSecondSave && applies.length === 2) { await route.fulfill({ status: 409, json: { error: { message: "本批资料已变化，请核对后重试" } } }); return; }
      for (const change of body.rows) {
        const row = rows.find(row => row.id === change.id)!;
        for (const value of change.values) row.extraFields[value.key] = value.value;
        row.updatedAt = `2026-10-24T01:${String(applies.length).padStart(2, "0")}:00Z`;
      }
      revision++; data = { updatedCount: body.rows.length, ids: body.rows.map((row: Values) => row.id) };
    }
    if (/\/style-selections(?:\/\d+|\/bulk)$/.test(path) && request.method() !== "GET") gridWrites.push(request.postDataJSON());
    await route.fulfill({ json: { data } });
  });
  await page.goto("/products");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(rows.length);
  return { rows, generations, applies, gridWrites, idempotencyKeys, release: () => release?.() };
}
async function openPanel(page: Page) {
  await page.getByRole("button", { name: "工具箱", exact: true }).click();
  await page.getByRole("button", { name: /AI 安全类别与执行标准/ }).click();
  return page.getByRole("dialog", { name: "AI 安全类别与执行标准", exact: true });
}

test("商品档案选中款式适配：只填空白、先核对、取消勾选和确认保存", async ({ page }) => {
  const state = await fixture(page);
  await page.locator('td[data-selection-row="1"][data-selection-column="xutiStyleNo"]').click();
  const panel = await openPanel(page);
  await expect(panel).toContainText("选中款式 · 1 款");
  await expect(panel).toContainText("洗唛/吊牌图不参与适配");
  await panel.getByRole("button", { name: "一键适配", exact: true }).click();
  await expect(panel).toContainText("FZ/T 81007-2022");
  expect(state.generations[0]).toMatchObject({ rowIds: ["1"], mode: "blank" });
  expect(state.applies).toHaveLength(0);
  expect(state.rows[0].extraFields["custom:standard"]).toBe("");
  await panel.getByText("查看适配依据", { exact: true }).click();
  await expect(panel).toContainText("实际读取：商品图片 1 张");
  await expect(panel).not.toContainText("洗唛/吊牌图 1 张");
  await panel.locator(".standards-cell").getByRole("checkbox", { name: "执行标准", exact: true }).uncheck();
  await expect(panel.getByRole("button", { name: /确认填入/ })).toBeDisabled();
  await panel.locator(".standards-cell").getByRole("checkbox", { name: "执行标准", exact: true }).check();
  await panel.screenshot({ path: test.info().outputPath("standards-preview.png") });
  await panel.getByRole("button", { name: "确认填入 1 个单元格", exact: true }).click();
  await expect(panel).toContainText("已保存 1 款");
  expect(state.rows[0].extraFields).toMatchObject({ "custom:safety": "已有安全类别", "custom:standard": "FZ/T 81007-2022" });
  expect(state.gridWrites).toHaveLength(0);
  expect(state.idempotencyKeys[0]).toBeTruthy();
  await panel.locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator('td[data-selection-row="1"][data-selection-column="custom:standard"]')).toContainText("FZ/T 81007-2022");
});

test("重新适配自动分批：资料不足不写入，后批失败保留成功并可幂等重试", async ({ page }) => {
  const state = await fixture(page, { count: 6, failSecondSave: true });
  const panel = await openPanel(page);
  await panel.getByRole("combobox", { name: "标准适配处理方式" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("重新适配（含已有内容）", { exact: true }).click();
  await panel.getByRole("button", { name: "一键适配", exact: true }).click();
  await expect.poll(() => state.generations.length).toBe(2);
  await expect(panel.getByRole("button", { name: "确认填入 11 个单元格" })).toBeEnabled();
  await expect(panel).toContainText("已处理 6 / 6 款 · 建议 11 个单元格 · 待核对 1 个单元格");
  expect(state.generations.map(batch => batch.rowIds.length)).toEqual([5, 1]);
  await expect(panel).toContainText("已有安全类别");
  const pending = panel.locator(".standards-candidate").filter({ hasText: "ST-3" });
  await expect(pending).toContainText("待补充资料");
  await expect(pending.getByRole("checkbox", { name: "执行标准", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: /确认填入/ }).click();
  await expect(panel).toContainText("本批资料已变化");
  expect(state.rows[0].extraFields["custom:safety"]).toBe("GB 18401-2010 C类");
  expect(state.rows[2].extraFields["custom:standard"]).toBe("");
  expect(state.rows[5].extraFields["custom:standard"]).toBe("");
  await panel.getByRole("button", { name: "确认填入 2 个单元格" }).click();
  await expect.poll(() => state.applies.length).toBe(3);
  expect(state.idempotencyKeys[2]).toBe(state.idempotencyKeys[1]);
  expect(state.rows[5].extraFields["custom:standard"]).toBe("FZ/T 81007-2022");
  expect(state.applies[2].rows.map((row: Values) => row.id)).toEqual(["6"]);
});

test("有条件的建议展示具体核对项，确认后只填入标准编号", async ({ page }) => {
  const state = await fixture(page, { count: 1, conditional: true });
  const panel = await openPanel(page);
  await panel.getByRole("button", { name: "一键适配", exact: true }).click();
  await expect(panel).toContainText("适用条件待核对");
  await expect(panel).toContainText("核对主面料为机织结构");
  await expect(panel).toContainText("核对是否有保暖填充");
  await expect(panel).toContainText("建议 1 个单元格 · 待核对 0 个单元格");
  expect(state.applies).toHaveLength(0);
  await panel.getByRole("button", { name: "确认填入 1 个单元格", exact: true }).click();
  await expect(panel).toContainText("已保存 1 款");
  expect(state.applies[0].rows[0].values).toEqual([{ key: "custom:standard", value: "FZ/T 81007-2022" }]);
  expect(state.rows[0].extraFields["custom:standard"]).toBe("FZ/T 81007-2022");
});

test("标准核验暂不可用时保留 AI 分析，不误报资料不足或允许填入", async ({ page }) => {
  const state = await fixture(page, { count: 1, unverified: true });
  const panel = await openPanel(page);
  await panel.getByRole("button", { name: "一键适配", exact: true }).click();
  await expect(panel).toContainText("AI 候选（暂不可填入）");
  await expect(panel).toContainText("QB/T 1615-2018");
  await expect(panel).toContainText("无需补填商品资料");
  await expect(panel).not.toContainText("待补充资料");
  await expect(panel.getByRole("checkbox", { name: "执行标准", exact: true }).last()).toBeDisabled();
  await expect(panel.getByRole("button", { name: "确认填入 0 个单元格", exact: true })).toBeDisabled();
  expect(state.applies).toHaveLength(0);
});

test("停止后续批次保留当前候选，关闭预览不会保存", async ({ page }) => {
  const state = await fixture(page, { count: 6, pauseFirst: true });
  const panel = await openPanel(page);
  await panel.getByRole("button", { name: "一键适配", exact: true }).click();
  await expect.poll(() => state.generations.length).toBe(1);
  await panel.getByRole("button", { name: "停止后续批次", exact: true }).click();
  state.release();
  await expect(panel.getByRole("button", { name: "继续适配剩余款式" })).toBeEnabled();
  expect(state.generations).toHaveLength(1);
  await panel.locator(".ant-modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  expect(state.applies).toHaveLength(0); expect(state.gridWrites).toHaveLength(0);
});

test("只读用户没有适配入口，未配置模型时不能发起适配", async ({ page }) => {
  await fixture(page, { readonly: true });
  await page.getByRole("button", { name: "工具箱", exact: true }).click();
  await expect(page.getByRole("button", { name: /AI 安全类别与执行标准/ })).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
  const state = await fixture(page, { configured: false });
  const panel = await openPanel(page);
  await expect(panel).toContainText("请先验证 AI 模型");
  await expect(panel.getByRole("button", { name: "一键适配", exact: true })).toBeDisabled();
  expect(state.generations).toHaveLength(0);
});
