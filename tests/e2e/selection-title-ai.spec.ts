import { expect, test, type Page } from "@playwright/test";
import { projectSelectionSharedLayout, selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";

type Values = Record<string, any>;
type FixtureOptions = { count?: number; configured?: boolean; pauseFirst?: boolean; failApplyBatch?: number; shortHanLimit?: number; longCharacterLimit?: number; longHanLimit?: number; firstTtlMs?: number; material?: string; longTitle?: string; path?: string; firstOriginal?: string; names?: string[]; series?: string };
const generatedLongTitle = "【100桑蚕丝】锦纨春秋冬新中式国风提花盘扣圆领背心女马甲";
const editedLongTitle = "【100桑蚕丝】庭春漾秋冬新中式国风提花盘扣圆领背心女马甲";
async function fixture(page: Page, options: FixtureOptions = {}) {
  await page.addInitScript(() => {
    const request = window.fetch.bind(window);
    window.fetch = (input, init) => init?.keepalive && String(input).includes("/api/v1/")
      ? Promise.resolve(new Response('{"data":null}', { headers: { "Content-Type": "application/json" } }))
      : request(input, init);
  });
  const longLimit = options.longHanLimit ?? options.longCharacterLimit ?? 30;
  const longCountMode = options.longHanLimit ? "han" : "characters";
  const preferences = selectionLayoutSchema.parse({ columns: [
    { key: "registrationBatch", label: "创建时间", type: "createdTime" },
    { key: "xutiStyleNo", label: "序缇款号", type: "text" },
    { key: "category", label: "三级类目", type: "text" },
    { key: "material", label: "成分", type: "text" },
    { key: "custom:long-title", label: "长标题", type: "text", custom: true, visibility: "PUBLIC", textConfig: { countMode: longCountMode, maxLength: longLimit } },
    { key: "custom:short-title", label: "短标题", type: "text", custom: true, visibility: "PUBLIC", ...(options.shortHanLimit ? { textConfig: { countMode: "han", maxLength: options.shortHanLimit } } : {}) },
  ] });
  const rows: Values[] = Array.from({ length: options.count ?? 3 }, (_, index) => ({
    id: String(index + 1), xutiStyleNo: `AI-${String(index + 1).padStart(3, "0")}`, category: "女式马夹", material: options.material || "面料：100%桑蚕丝",
    registrationBatch: "2026-10-11T00:00:00Z", createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z", images: [], labelImages: [],
    extraFields: { "custom:long-title": index === 0 && options.count !== 12 ? options.firstOriginal ?? "已填写长标题" : "", "custom:short-title": "" },
  }));
  if (options.count !== 12) rows[2].extraFields = { "custom:long-title": "原有长标题", "custom:short-title": "原有短标题" };
  let revision = 1;
  const generations: Values[] = [], applies: Values[] = [], gridWrites: Values[] = [], applyKeys: string[] = [];
  let releaseFirst: (() => void) | undefined;
  await page.route("**/api/v1/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (path.endsWith("/auth/me")) data = { id: "101", displayName: "标题测试", csrfToken: "fixture", roleCodes: ["SUPER_ADMIN"], permissions: ["selection.read", "selection.manage", "selection.protect", "product.read", "product.manage", "project.read", "project.create", "setting.manage"] };
    if (path.endsWith("/product-archive-table")) data = { id: "3", initialLayout: "selection", fields: [], references: {}, canEdit: true, canManage: true };
    if (path.endsWith("/project-tables/7")) data = { id: "7", name: "标题测试协作表", initialLayout: "selection", canEdit: true, canManage: true };
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
          const name = options.names?.[Number(id) - 1];
          return { id, xutiStyleNo: row.xutiStyleNo, expectedUpdatedAt: row.updatedAt, evidence: [`成分：${row.material}`, "三级类目：女式马夹"], warnings: ["款名请人工核对"],
            ...(name ? { poeticName: name, series: options.series || "" } : {}),
            titles: body.targetKeys.filter((key: string) => body.mode === "complete" ? key === "custom:long-title" && Array.from(String(row.extraFields[key] || "").trim()).length < 30 : body.mode === "improve" ? !!row.extraFields[key]?.trim() : !row.extraFields[key]?.trim()).map((key: string) => ({ key, label: key === "custom:long-title" ? "长标题" : "短标题", kind: key === "custom:long-title" ? "long" : "short",
              previousValue: row.extraFields[key] || "", ...(body.mode === "complete" ? { maxCharacters: 30 } : {}),
              value: (key === "custom:long-title" ? options.longTitle || (body.mode === "complete" ? generatedLongTitle + "款" : generatedLongTitle) : "锦纨春马甲").replace("锦纨春", name || "锦纨春"), minCharacters: key === "custom:long-title" ? body.mode === "complete" ? 30 : 29 : 1, maxLength: key === "custom:long-title" ? longLimit : options.shortHanLimit || 30, countMode: key === "custom:long-title" ? longCountMode : key === "custom:short-title" && options.shortHanLimit ? "han" : "characters" })),
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
  await page.goto(options.path || "/style-selections");
  await expect(page.locator("tr[data-selection-row]")).toHaveCount(rows.length);
  return { rows, generations, applies, gridWrites, applyKeys, releaseFirst: () => releaseFirst?.() };
}
async function openPanel(page: Page) {
  await page.getByRole("button", { name: "工具箱", exact: true }).click();
  await page.getByRole("button", { name: /AI 商品标题$/ }).click();
  return page.getByRole("dialog", { name: "AI 商品标题生成", exact: true });
}

async function chooseMode(page: Page, label: string) {
  await page.getByRole("combobox", { name: "标题处理方式" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText(label, { exact: true }).click();
}

test("独立款式重名时禁止保存，改名联动标题且接受 2–4 字", async ({ page }) => {
  const state = await fixture(page, { names: ["花间序", "花间序"] }), panel = await openPanel(page);
  await panel.getByRole("checkbox", { name: /^长标题/ }).uncheck();
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  const apply = panel.getByRole("button", { name: "确认填补 2 个空白单元格", exact: true });
  await expect(apply).toBeDisabled();
  await expect(panel.getByText(/款名与其他款式重名/).first()).toBeVisible();
  const name = panel.getByLabel("AI-002 款名/别名");
  await name.fill("云");
  await expect(apply).toBeDisabled();
  await name.fill("花序");
  await expect(panel.getByLabel("AI-002 短标题候选")).toHaveValue("花序马甲");
  await expect(apply).toBeEnabled();
  await name.fill("山月听泉");
  await expect(panel.getByLabel("AI-002 短标题候选")).toHaveValue("山月听泉马甲");
  await apply.click();
  expect(state.applies[0].rows[1]).toMatchObject({ poeticName: "山月听泉", titles: [{ value: "山月听泉马甲" }] });
});

test("同面料纹样配套系列可共用款名", async ({ page }) => {
  await fixture(page, { names: ["花间序", "花间序"], series: "丝缎花枝配套" });
  const panel = await openPanel(page);
  await panel.getByRole("checkbox", { name: /^长标题/ }).uncheck();
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel.getByText("所属系列：丝缎花枝配套").first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "确认填补 2 个空白单元格", exact: true })).toBeEnabled();
});

test("连续生成时将前批未保存款名传给后批避重", async ({ page }) => {
  const names = ["花间序", "听风吟", "松间月", "山水歌", "溪上舟", "星河赋", "庭前雨", "流泉音", "云岫行", "远山曲", "春水谣", "池畔语"];
  const state = await fixture(page, { count: 12, names }), panel = await openPanel(page);
  await panel.getByRole("checkbox", { name: /^长标题/ }).uncheck();
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect.poll(() => state.generations.length).toBe(2);
  expect(state.generations[1].pendingNames).toEqual(names.slice(0, 10).map((name, index) => ({ rowId: String(index + 1), name })));
  await expect(panel.getByRole("button", { name: "确认填补 12 个空白单元格", exact: true })).toBeEnabled();
});

for (const [module, path] of [["商品档案", "/products"], ["选款登记", "/style-selections"], ["项目协作表格", "/project-tables/7"]]) {
  test(`${module}选中已有长标题自动补全至30字符，先对照原文再确认`, async ({ page }) => {
    const original = "【含绵羊毛】秋冬简约百搭中长款休闲半身裙裙子女";
    const state = await fixture(page, { path, firstOriginal: original });
    await page.locator('td[data-selection-row="1"][data-selection-column="custom:long-title"]').click();
    const panel = await openPanel(page);
    await expect(panel.getByText("补全不足 30 字符的长标题", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
    expect(state.generations[0]).toMatchObject({ mode: "complete", rowIds: ["1"], targetKeys: ["custom:long-title"] });
    await expect(panel.getByLabel("AI-001 长标题原文")).toContainText(original);
    if (module === "商品档案") await panel.screenshot({ path: test.info().outputPath("title-completion.png") });
    expect(state.rows[0].extraFields["custom:long-title"]).toBe(original);
    expect(state.applies).toHaveLength(0);
    const candidate = panel.getByLabel("AI-001 长标题候选");
    const apply = panel.getByRole("button", { name: "确认更新 1 个标题单元格", exact: true });
    await candidate.fill(generatedLongTitle);
    await expect(apply).toBeDisabled();
    await expect(panel).toContainText("长标题至少30个字符");
    await candidate.fill(generatedLongTitle + "衣款");
    await expect(apply).toBeDisabled();
    await candidate.fill(generatedLongTitle + "款");
    await apply.click();
    await expect(panel).toContainText("已更新 1 款的标题");
    expect(state.rows[0].extraFields).toMatchObject({ "custom:long-title": generatedLongTitle + "款", "custom:short-title": "" });
    expect(state.rows[1].extraFields["custom:long-title"]).toBe("");
    expect(state.gridWrites).toHaveLength(0);
  });
}

test("完善已有长短标题，跳过空白并保留取消勾选的原文", async ({ page }) => {
  const state = await fixture(page), panel = await openPanel(page);
  await chooseMode(page, "基于现有描述完善标题");
  await expect(panel).toContainText("2 款符合处理条件");
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  expect(state.generations[0]).toMatchObject({ mode: "improve", rowIds: ["1", "3"] });
  await expect(panel.getByLabel("AI-001 长标题原文")).toContainText("已填写长标题");
  await expect(panel.getByLabel("AI-003 短标题原文")).toContainText("原有短标题");
  await expect(panel.getByLabel("AI-002 长标题候选")).toHaveCount(0);
  await panel.locator(".selection-title-ai-candidate").filter({ hasText: "AI-003" }).getByRole("checkbox", { name: "短标题", exact: true }).uncheck();
  await panel.getByRole("button", { name: "确认更新 2 个标题单元格", exact: true }).click();
  await expect(panel).toContainText("已更新 2 款的标题");
  expect(state.rows[2].extraFields).toMatchObject({ "custom:long-title": generatedLongTitle, "custom:short-title": "原有短标题" });
  expect(state.rows[1].extraFields).toMatchObject({ "custom:long-title": "", "custom:short-title": "" });
  expect(state.gridWrites).toHaveLength(0);
});

test("已有30字符长标题可完善，切换补全后无符合记录不会调用模型", async ({ page }) => {
  const state = await fixture(page, { firstOriginal: generatedLongTitle + "款" });
  const cell = page.locator('td[data-selection-row="1"][data-selection-column="custom:long-title"]');
  await cell.click();
  await cell.click({ button: "right" });
  await page.getByRole("menuitem", { name: /AI 商品标题/ }).click();
  const panel = page.getByRole("dialog", { name: "AI 商品标题生成", exact: true });
  await expect(panel.getByText("基于现有描述完善标题", { exact: true })).toBeVisible();
  await chooseMode(page, "补全不足 30 字符的长标题");
  await expect(panel).toContainText("0 款符合处理条件");
  await expect(panel.getByRole("button", { name: "生成候选标题", exact: true })).toBeDisabled();
  expect(state.generations).toHaveLength(0);
});

test("补全需要字段允许30字符，明确提示且不调用模型", async ({ page }) => {
  const state = await fixture(page, { longCharacterLimit: 29 });
  await page.locator('td[data-selection-row="1"][data-selection-column="custom:long-title"]').click();
  const panel = await openPanel(page);
  await expect(panel).toContainText("长标题字段最多 29 字符，小于 AI 长标题至少 30 字符的要求");
  await expect(panel.getByRole("button", { name: "生成候选标题", exact: true })).toBeDisabled();
  expect(state.generations).toHaveLength(0);
});

test("完善保存遇到并发冲突保留原文和候选，关闭未确认候选不写入", async ({ page }) => {
  const state = await fixture(page, { failApplyBatch: 1 }), panel = await openPanel(page);
  await chooseMode(page, "基于现有描述完善标题");
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await panel.getByRole("button", { name: "确认更新 3 个标题单元格", exact: true }).click();
  await expect(panel).toContainText("商品资料已变化，请重新生成候选");
  await expect(panel.getByLabel("AI-001 长标题候选")).toHaveValue(generatedLongTitle);
  expect(state.rows[0].extraFields["custom:long-title"]).toBe("已填写长标题");
  await panel.getByRole("button", { name: "关闭", exact: true }).filter({ hasText: "关闭" }).click();
  expect(state.applies).toHaveLength(1);
  expect(state.gridWrites).toHaveLength(0);
});

test("候选先核对再填补，已有标题保留，可编辑和取消单元格，避免网格自动保存", async ({ page }) => {
  const state = await fixture(page), panel = await openPanel(page);
  await expect(panel).toContainText("OpenRouter 和所选模型供应商");
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel.getByLabel("AI-002 长标题候选")).toBeVisible();
  expect(state.applies).toHaveLength(0);
  await expect(panel.getByLabel("AI-001 长标题候选")).toHaveCount(0);
  await panel.getByLabel("AI-002 长标题候选").fill(editedLongTitle);
  await panel.locator(".selection-title-ai-candidate").filter({ hasText: "AI-002" }).getByRole("checkbox", { name: "短标题", exact: true }).uncheck();
  await panel.getByRole("button", { name: "确认填补 2 个空白单元格", exact: true }).click();
  await expect(panel).toContainText("已填补 2 款的空白标题");
  expect(state.applies[0].rows).toEqual([
    { id: "1", titles: [{ key: "custom:short-title", value: "锦纨春马甲" }] },
    { id: "2", titles: [{ key: "custom:long-title", value: editedLongTitle }] },
  ]);
  expect(state.rows[0].extraFields["custom:long-title"]).toBe("已填写长标题");
  expect(state.rows[2].extraFields["custom:short-title"]).toBe("原有短标题");
  expect(state.rows[1].material).toBe("面料：100%桑蚕丝");
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
  await title.fill("锦纨春丝绸背心马甲");
  await expect(panel.getByRole("button", { name: /确认填补/ })).toBeDisabled();
  await expect(panel).toContainText("超过6个汉字");
  expect(state.applies).toHaveLength(0);
  await title.fill("锦纨春 A B");
  await expect(panel.getByRole("button", { name: /确认填补/ })).toBeEnabled();
  await panel.getByRole("button", { name: /确认填补/ }).click();
  await expect.poll(() => state.applies.length).toBe(1);
  expect(state.applies[0].rows[0].titles[0].value).toBe("锦纨春 A B");
});

test("编辑候选不允许部位标签、颜色、不足100%比例和普通化纤，准确混纺卖点可填补且保留已有标题", async ({ page }) => {
  const legalMixedTitle = "【含山羊绒桑蚕丝】锦纨春秋冬新中式国风提花盘扣圆领背心女马甲";
  const state = await fixture(page, {
    material: "面料：70%山羊绒30%桑蚕丝\n里料：100%聚酯纤维",
    longTitle: legalMixedTitle,
  }), panel = await openPanel(page);
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  const title = panel.getByLabel("AI-002 长标题候选");
  const candidate = panel.locator(".selection-title-ai-candidate").filter({ hasText: "AI-002" });
  const apply = panel.getByRole("button", { name: /确认填补/ });
  await expect(title).toHaveValue(legalMixedTitle);
  const invalidTitles = [
    { value: "【面料100桑蚕丝】锦纨春秋冬新中式国风盘扣圆领背心女马甲", issue: "标题不填写面料、里料、填充物、配料等部位标签" },
    { value: "【100桑蚕丝】碧纨春秋冬新中式国风提花盘扣圆领背心女马甲", issue: "标题不填写颜色描述，原创款名也应避开颜色词" },
    { value: "【70山羊绒30桑蚕丝】锦纨春秋冬新中式国风提花盘扣背心马甲", issue: "不足100%的材质不写具体含量比例" },
    { value: "【100聚酯纤维】锦纨春秋冬新中式国风提花盘扣圆领背心女马甲", issue: "标题不写化纤、聚酯、氨纶等普通材质" },
  ];
  for (const invalid of invalidTitles) {
    expect(Array.from(invalid.value).length).toBeGreaterThanOrEqual(29);
    expect(Array.from(invalid.value).length).toBeLessThanOrEqual(30);
    await title.fill(invalid.value);
    await expect(candidate.locator(".selection-title-ai-count.is-error")).toContainText(invalid.issue);
    await expect(apply).toBeDisabled();
    expect(state.applies).toHaveLength(0);
  }
  await title.fill(legalMixedTitle);
  await expect(apply).toBeEnabled();
  const short = panel.getByLabel("AI-001 短标题候选");
  await short.fill("暖橙盘扣背心马甲");
  await expect(apply).toBeDisabled();
  await expect(panel.locator(".selection-title-ai-candidate").filter({ hasText: "AI-001" }).locator(".selection-title-ai-count.is-error")).toContainText("标题不填写颜色描述");
  await short.fill("锦纨春盘扣背心马甲");
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect.poll(() => state.applies.length).toBe(1);
  expect(state.applies[0].rows).toEqual([
    { id: "1", titles: [{ key: "custom:short-title", value: "锦纨春盘扣背心马甲" }] },
    { id: "2", titles: [{ key: "custom:long-title", value: legalMixedTitle }, { key: "custom:short-title", value: "锦纨春马甲" }] },
  ]);
  expect(state.rows[0].extraFields["custom:long-title"]).toBe("已填写长标题");
  expect(state.rows[2].extraFields["custom:long-title"]).toBe("原有长标题");
  expect(state.rows[2].extraFields["custom:short-title"]).toBe("原有短标题");
  expect(state.rows[1].material).toBe("面料：70%山羊绒30%桑蚕丝\n里料：100%聚酯纤维");
  expect(state.gridWrites).toHaveLength(0);
});

test("长标题至少29字符且不超过当前30字符上限，空格不能补足长度，短标题保持独立", async ({ page }) => {
  const state = await fixture(page), panel = await openPanel(page);
  await expect(panel).toContainText("长标题（至少 29 字符；最多 30字符）");
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  const title = panel.getByLabel("AI-002 长标题候选"), apply = panel.getByRole("button", { name: /确认填补/ });
  await title.fill(`  ${generatedLongTitle.slice(0, -1)}  `);
  await expect(panel).toContainText("长标题至少29个字符");
  await expect(apply).toBeDisabled();
  await title.fill(generatedLongTitle);
  await expect(panel).toContainText("29 / 30 字符（至少 29）");
  await expect(apply).toBeEnabled();
  await title.fill(`${generatedLongTitle}款`);
  await expect(panel).toContainText("30 / 30 字符（至少 29）");
  await expect(apply).toBeEnabled();
  await title.fill(`${generatedLongTitle}新款`);
  await expect(panel).toContainText("超过30个字符");
  await expect(apply).toBeDisabled();
  await panel.locator(".selection-title-ai-candidate").filter({ hasText: "AI-002" }).getByRole("checkbox", { name: "长标题", exact: true }).uncheck();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect.poll(() => state.applies.length).toBe(1);
  expect(state.applies[0].rows.every((row: Values) => row.titles.every((item: Values) => item.key === "custom:short-title"))).toBe(true);
});

test("长标题字段字符上限小于29时清楚阻止生成，可取消长标题单独生成短标题", async ({ page }) => {
  const state = await fixture(page, { longCharacterLimit: 28 }), panel = await openPanel(page);
  await expect(panel).toContainText("长标题字段最多 28 字符，小于 AI 长标题至少 29 字符的要求");
  await expect(panel).toContainText("请在字段管理中将上限调整至 29 或以上");
  await expect(panel.getByRole("button", { name: "生成候选标题", exact: true })).toBeDisabled();
  const long = panel.getByRole("checkbox", { name: /长标题（至少/ });
  await expect(long).toBeChecked();
  await long.uncheck();
  await expect(long).toBeDisabled();
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel.getByLabel("AI-001 短标题候选")).toBeVisible();
  expect(state.generations[0].targetKeys).toEqual(["custom:short-title"]);
  expect(state.applies).toHaveLength(0);
});

test("右键只生成长标题且字段上限不足29时保留目标并提示调整，不会无声改成短标题", async ({ page }) => {
  const state = await fixture(page, { longCharacterLimit: 28 });
  const titleCell = page.locator('td[data-selection-row="2"][data-selection-column="custom:long-title"]');
  await titleCell.click();
  await titleCell.click({ button: "right" });
  await page.getByRole("menuitem", { name: /AI 商品标题/ }).click();
  const panel = page.getByRole("dialog", { name: "AI 商品标题生成", exact: true });
  await expect(panel.getByRole("checkbox", { name: /长标题（至少/ })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: /短标题（/ })).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "生成候选标题", exact: true })).toBeDisabled();
  await expect(panel).toContainText("当前不能生成长标题");
  expect(state.generations).toHaveLength(0);
});

test("长标题最少29个Unicode字符和字段汉字上限分别计数", async ({ page }) => {
  const state = await fixture(page, { longHanLimit: 26 }), panel = await openPanel(page);
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  const title = panel.getByLabel("AI-002 长标题候选"), apply = panel.getByRole("button", { name: /确认填补/ });
  await title.fill(`【A】${"衣".repeat(25)}`);
  await expect(panel).toContainText("28 字符（至少 29） · 25 / 26 汉字");
  await expect(apply).toBeDisabled();
  await title.fill(`【A】${"衣".repeat(26)}`);
  await expect(panel).toContainText("29 字符（至少 29） · 26 / 26 汉字");
  await expect(apply).toBeEnabled();
  await title.fill(`【A】${"衣".repeat(27)}`);
  await expect(panel).toContainText("超过26个汉字");
  await expect(apply).toBeDisabled();
  expect(state.applies).toHaveLength(0);
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
  await page.getByRole("menuitem", { name: /AI 商品标题/ }).click();
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
  await expect(panel).toContainText("部分候选已过期，不能保存");
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
  await page.getByRole("menuitem", { name: /AI 商品标题/ }).click();
  const panel = page.getByRole("dialog", { name: "AI 商品标题生成", exact: true });
  await expect(panel).toContainText("当前筛选结果（含其他页） · 12 款有空白标题");
  await panel.getByRole("button", { name: "生成候选标题", exact: true }).click();
  await expect(panel).toContainText("候选标题 · 12 款");
  expect(state.generations.map(item => item.rowIds.length)).toEqual([10, 2]);
  expect(state.generations.every(item => JSON.stringify(item.targetKeys) === JSON.stringify(["custom:short-title"]))).toBe(true);
  expect(state.applies).toHaveLength(0);
});
