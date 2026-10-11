import { expect, test, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

type Values = Record<string, any>;
type FixtureOptions = { count?: number; configured?: boolean; pauseFirst?: boolean; failApplyBatch?: number; shortHanLimit?: number; firstTtlMs?: number };
async function fixture(page: Page, options: FixtureOptions = {}) {
  const preferences = selectionLayoutSchema.parse({ columns: [
    { key: "registrationBatch", label: "创建时间", type: "createdTime" },
    { key: "xutiStyleNo", label: "序缇款号", type: "text" },
    { key: "category", label: "三级类目", type: "text" },
    { key: "material", label: "成分", type: "text" },
    { key: "custom:long-title", label: "长标题", type: "text", custom: true, visibility: "PUBLIC", textConfig: { countMode: "characters", maxLength: 60 } },
    { key: "custom:short-title", label: "短标题", type: "text", custom: true, visibility: "PUBLIC", ...(options.shortHanLimit ? { textConfig: { countMode: "han", maxLength: options.shortHanLimit } } : {}) },
  ] });
  const rows: Values[] = Array.from({ length: options.count ?? 3 }, (_, index) => ({
    id: String(index + 1), xutiStyleNo: `AI-${String(index + 1).padStart(3, "0")}`, category: "女式马夹", material: "面料：100%桑蚕丝",
    registrationBatch: "2026-10-11T00:00:00Z", createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z", images: [], labelImages: [],
    extraFields: { "custom:long-title": index === 0 && options.count !== 12 ? "已填写长标题" : "", "custom:short-title": "" },
  }));
  if (options.count !== 12) rows[2].extraFields = { "custom:long-title": "原有长标题", "custom:short-title": "原有短标题" };
  let revision = 1;
  const generations: Values[] = [], applies: Values[] = [], gridWrites: Values[] = [], applyKeys: string[] = [];
  let releaseFirst: (() => void) | undefined;
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "标题测试", csrfToken: "fixture", roleCodes: ["SUPER_ADMIN"], permissions: ["selection.read", "selection.manage", "selection.protect", "product.read", "product.manage", "project.read", "project.create", "setting.manage"] };
    if (path.endsWith("/revision")) data = { revision: String(revision) };
    if (path.endsWith("/sync")) data = { revision: String(revision), index: rows.map(row => ({ id: row.id, token: row.updatedAt })), data: rows };
    if (path.endsWith("/shared-view")) data = { revision: 0, view: { filters: {}, sort: null } };
    if (path.endsWith("/layout-preferences")) data = { preferences, revision: 1, sharedPreferences: projectSelectionSharedLayout(preferences), sharedRevision: 1, canEditShared: true };
    if (path.endsWith("/ai-titles/status")) data = { ready: options.configured !== false, message: options.configured === false ? "请先在系统设置配置 OpenRouter API Key 和文本模型" : "AI 标题服务已就绪" };
    if (path.endsWith("/ai-titles/generate")) {
      const body = request.postDataJSON(); generations.push(body);
      if (options.pauseFirst && generations.length === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
      data = { planToken: `title-ai-fixture-plan-${generations.length}-abcdefghijklmnop`, expiresAt: new Date(Date.now() + (generations.length === 1 ? options.firstTtlMs ?? 30 * 60 * 1000 : 30 * 60 * 1000)).toISOString(), model: "fixture-model", warnings: [],
        rows: body.rowIds.map((id: string) => {
          const row = rows.find(row => row.id === id)!;
          return { id, xutiStyleNo: row.xutiStyleNo, expectedUpdatedAt: row.updatedAt, evidence: ["成分：面料100%桑蚕丝", "三级类目：女式马夹"], warnings: ["款名请人工核对"],
            titles: body.targetKeys.filter((key: string) => !row.extraFields[key]?.trim()).map((key: string) => ({ key, label: key === "custom:long-title" ? "长标题" : "短标题", kind: key === "custom:long-title" ? "long" : "short",
              value: key === "custom:long-title" ? "【100桑蚕丝】新中式马甲" : "碧纨春马甲", maxLength: key === "custom:long-title" ? 60 : options.shortHanLimit || 30, countMode: key === "custom:short-title" && options.shortHanLimit ? "han" : "characters" })),
          };
        }).filter((row: Values) => row.titles.length),
      };
    }
    if (path.endsWith("/ai-titles/apply")) {
      const body = request.postDataJSON(); applies.push(body); applyKeys.push(request.headers()["idempotency-key"]);
      if (applies.length === options.failApplyBatch) { await route.fulfill({ status: 409, json: { error: { message: "商品资料已变化，请重新生成候选" } } }); return; }
      for (const item of body.rows) {
        const row = rows.find(row => row.id === item.id)!;
        for (const title of item.titles) row.extraFields[title.key] = title.value;
        row.updatedAt = `2026-10-11T01:${String(applies.length).padStart(2, "0")}:00Z`;
      }
      revision++;
      data = { updatedCount: body.rows.length, ids: body.rows.map((row: Values) => row.id) };
    }
    if (/\/style-selections(?:\/\d+|\/bulk)$/.test(path) && request.method() !== "GET") gridWrites.push(request.postDataJSON());
    await route.fulfill({ json: { data } });
  });
  await page.goto("/style-selections");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(rows.length);
  return { rows, generations, applies, gridWrites, applyKeys, releaseFirst: () => releaseFirst?.() };
}
async function openPanel(page: Page) {
  await page.getByRole("button", { name: /AI 商品标题$/ }).click();
  return page.getByRole("dialog", { name: "AI 商品标题生成", exact: true });
}

test("候选先核对再填补，已有标题保留，可编辑和取消单元格，避免网格自动保存", async ({ page }) => {
  const state = await fixture(page), panel = await openPanel(page);
  await expect(panel).toContainText("OpenRouter 和所选模型供应商");
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel.getByLabel("AI-002 长标题候选")).toBeVisible();
  expect(state.applies).toHaveLength(0);
  await expect(panel.getByLabel("AI-001 长标题候选")).toHaveCount(0);
  await panel.getByLabel("AI-002 长标题候选").fill("【100桑蚕丝】碧纨春新中式马甲");
  await panel.locator(".selection-title-ai-candidate").filter({ hasText: "AI-002" }).getByRole("checkbox", { name: "短标题", exact: true }).uncheck();
  await panel.getByRole("button", { name: "确认填补 2 个空白单元格", exact: true }).click();
  await expect(panel).toContainText("已填补 2 款的空白标题");
  expect(state.applies[0].rows).toEqual([
    { id: "1", titles: [{ key: "custom:short-title", value: "碧纨春马甲" }] },
    { id: "2", titles: [{ key: "custom:long-title", value: "【100桑蚕丝】碧纨春新中式马甲" }] },
  ]);
  expect(state.rows[0].extraFields["custom:long-title"]).toBe("已填写长标题");
  expect(state.rows[2].extraFields["custom:short-title"]).toBe("原有短标题");
  expect(state.gridWrites).toHaveLength(0);
});

test("停止后续生成保留当前批次，继续时只处理未生成的款式", async ({ page }) => {
  const state = await fixture(page, { count: 12, pauseFirst: true }), panel = await openPanel(page);
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect.poll(() => state.generations.length).toBe(1);
  await panel.getByRole("button", { name: "停止后续生成", exact: true }).click();
  state.releaseFirst();
  await expect(panel).toContainText("候选标题 · 10 款");
  expect(state.generations).toHaveLength(1);
  expect(state.applies).toHaveLength(0);
  await panel.getByRole("button", { name: "继续生成剩余款式", exact: true }).click();
  await expect(panel).toContainText("候选标题 · 12 款");
  expect(state.generations.map(item => item.rowIds.length)).toEqual([10, 2]);
  expect(new Set(state.generations.flatMap(item => item.rowIds)).size).toBe(12);
});

test("用户修改候选超过汉字限制时阻止填补，修改后按原有汉字计数保存", async ({ page }) => {
  const state = await fixture(page, { shortHanLimit: 6 }), panel = await openPanel(page);
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  const title = panel.getByLabel("AI-001 短标题候选");
  await title.fill("碧纨春丝绸背心马甲");
  await expect(panel.getByRole("button", { name: /确认填补/ })).toBeDisabled();
  await expect(panel).toContainText("超过6个汉字");
  expect(state.applies).toHaveLength(0);
  await title.fill("碧纨春 A B");
  await expect(panel.getByRole("button", { name: /确认填补/ })).toBeEnabled();
  await panel.getByRole("button", { name: /确认填补/ }).click();
  await expect.poll(() => state.applies.length).toBe(1);
  expect(state.applies[0].rows[0].titles[0].value).toBe("碧纨春 A B");
});

test("后续批次冲突保留候选，已完成批次不会重复写入", async ({ page }) => {
  const state = await fixture(page, { count: 12, failApplyBatch: 2 }), panel = await openPanel(page);
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel).toContainText("候选标题 · 12 款");
  await panel.getByRole("button", { name: "确认填补 24 个空白单元格", exact: true }).click();
  await expect(panel).toContainText("商品资料已变化，请重新生成候选");
  await expect(panel).toContainText("候选标题 · 2 款");
  await expect(panel).toContainText("已填补 10 款的空白标题");
  expect(state.applies.map(item => item.rows.length)).toEqual([10, 2]);
  await panel.getByRole("button", { name: "确认填补 4 个空白单元格", exact: true }).click();
  await expect.poll(() => state.applies.length).toBe(3);
  expect(state.applies[2].rows.map((row: Values) => row.id)).toEqual(["11", "12"]);
  expect(state.applyKeys[1]).toBe(state.applyKeys[2]);
  expect(state.gridWrites).toHaveLength(0);
});

test("未配置 AI 时清楚提示管理员设置，不能生成或填补", async ({ page }) => {
  const state = await fixture(page, { configured: false }), panel = await openPanel(page);
  await expect(panel).toContainText("请先在系统设置配置 OpenRouter API Key 和文本模型");
  await expect(panel.getByRole("button", { name: "生成候选标题", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: /确认填补/ })).toBeDisabled();
  expect(state.generations).toHaveLength(0);
  expect(state.applies).toHaveLength(0);
});

test("勾选行限定生成范围，右键标题单元格只生成该行该字段", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("checkbox", { name: "选择 AI-001", exact: true }).check();
  let panel = await openPanel(page);
  await expect(panel).toContainText("选中范围 · 1 款有空白标题");
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel.getByLabel("AI-001 短标题候选")).toBeVisible();
  expect(state.generations[0].rowIds).toEqual(["1"]);
  await panel.getByRole("button", { name: "关闭", exact: true }).filter({ hasText: "关闭" }).click();
  await page.getByRole("checkbox", { name: "选择 AI-001", exact: true }).uncheck();
  const titleCell = page.locator('td[data-selection-row="2"][data-selection-column="custom:long-title"]');
  await titleCell.click();
  await titleCell.click({ button: "right" });
  await page.getByRole("menuitem", { name: /AI 填补空白标题/ }).click();
  panel = page.getByRole("dialog", { name: "AI 商品标题生成", exact: true });
  await expect(panel).toContainText("选中范围 · 1 款有空白标题");
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel.getByLabel("AI-002 长标题候选")).toBeVisible();
  expect(state.generations[1]).toMatchObject({ rowIds: ["2"], targetKeys: ["custom:long-title"] });
  expect(state.applies).toHaveLength(0);
});

test("候选临近过期时暂停后续批次，先保存有效候选后可继续剩余款式", async ({ page }) => {
  const state = await fixture(page, { count: 12, firstTtlMs: 2 * 60 * 1000 }), panel = await openPanel(page);
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel).toContainText("候选标题 · 10 款");
  await expect(panel).toContainText("候选即将过期，请先确认已生成内容，再继续剩余款式");
  expect(state.generations).toHaveLength(1);
  await panel.getByRole("button", { name: "确认填补 20 个空白单元格", exact: true }).click();
  await expect(panel).toContainText("已填补 10 款的空白标题");
  await panel.getByRole("button", { name: "继续生成剩余款式", exact: true }).click();
  await expect(panel).toContainText("候选标题 · 2 款");
  expect(state.generations.map(item => item.rowIds.length)).toEqual([10, 2]);
});

test("过期候选明确标注并禁止保存，移除后只重新生成这些行", async ({ page }) => {
  const state = await fixture(page, { count: 12, firstTtlMs: -1 }), panel = await openPanel(page);
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel).toContainText("部分候选已过期，不能填补");
  await expect(panel.getByRole("button", { name: /确认填补/ })).toBeDisabled();
  await expect(panel.getByLabel("AI-001 长标题候选")).toBeDisabled();
  expect(state.generations).toHaveLength(1);
  expect(state.applies).toHaveLength(0);
  await panel.getByRole("button", { name: "移除过期候选", exact: true }).click();
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel).toContainText("候选标题 · 12 款");
  expect(state.generations.map(item => item.rowIds.length)).toEqual([10, 10, 2]);
});

test("右键标题整列处理全部筛选款式，自动分批且不误认为仅当前行", async ({ page }) => {
  const state = await fixture(page, { count: 12 });
  const header = page.getByRole("columnheader", { name: "选择整列：短标题", exact: true });
  await header.click();
  await header.click({ button: "right" });
  await page.getByRole("menuitem", { name: /AI 填补空白标题/ }).click();
  const panel = page.getByRole("dialog", { name: "AI 商品标题生成", exact: true });
  await expect(panel).toContainText("当前筛选结果（含其他页） · 12 款有空白标题");
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel).toContainText("候选标题 · 12 款");
  expect(state.generations.map(item => item.rowIds.length)).toEqual([10, 2]);
  expect(state.generations.every(item => JSON.stringify(item.targetKeys) === JSON.stringify(["custom:short-title"]))).toBe(true);
  expect(state.applies).toHaveLength(0);
});
