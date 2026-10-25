import { expect, test, type Page } from "@playwright/test";
import type { AssistantActivity } from "../../packages/contracts/src/assistant-activity.js";

async function workspaceFixture(
  page: Page,
  options: { state?: string; permissions?: string[] } = {},
) {
  await page.clock.setFixedTime(new Date("2026-10-26T02:00:00Z"));
  const permissions = options.permissions || [
    "analytics.read",
    "analytics.manage",
    "product.read",
    "product.update",
    "selection.read",
    "selection.manage",
  ];
  const report: Record<string, any> = {
    state: options.state || "READY",
    model: "openai/gpt-6.1-sol",
    responseModel: "openai/gpt-6.1-sol",
    reportDate: "2026-10-24",
    generatedAt: "2026-10-25T00:10:00Z",
    message:
      options.state === "WAITING_DATA"
        ? "等待同一截止日期的三张完整近30天报表"
        : undefined,
    ...(options.state && options.state !== "READY"
      ? {}
      : {
          content: {
            summary: "近7天销售增长，优先核对畅销款库存与退货原因。",
            actions: ["核查缺货"],
            observations: ["销售增长"],
            risks: ["库存为截止日快照"],
          },
        }),
  };
  let reads = 0,
    generates = 0,
    settingsReads = 0;
  const submitted: unknown[] = [];
  const workspace: Record<string, any> = {
    version: 1,
    updatedAt: "2026-10-24T00:00:00Z",
    note: "仅自己的备忘，不发送给模型",
    todos: [],
    schedule: [],
    shortcuts: ["analytics", "products", "inventory"],
    available: [
      {
        id: "analytics",
        title: "经营分析",
        description: "销售趋势与经营数据",
        group: "运营",
        path: "/analytics/compass",
      },
      {
        id: "products",
        title: "商品档案",
        description: "商品资料与 AI 工具",
        group: "商品",
        path: "/products",
      },
      {
        id: "inventory",
        title: "库存明细",
        description: "库存与补货建议",
        group: "仓储",
        path: "/operations/vip/inventory",
      },
    ],
    defaults: { name: "个人工作台", description: "处理今天的工作", tools: [] },
  };
  let assistantCalls = 0;
  const activities: AssistantActivity[] = [];
  const assistant: Record<string, any> = {
    ready: true,
    availabilityMessage: "个人助理已就绪",
    model: "openai/gpt-6.1-sol",
    version: 0,
    state: "IDLE",
    error: "",
    messages: [],
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "105",
        displayName: "工作台测试",
        username: "workspace",
        roleCodes: [],
        permissions,
        csrfToken: "fixture",
      };
    if (path === "/my-workspace/appearance")
      data = { mode: "dark", version: 0 };
    if (path === "/my-workspace") {
      if (request.method() === "POST")
        Object.assign(workspace, request.postDataJSON(), {
          version: workspace.version + 1,
        });
      data = workspace;
    }
    if (path === "/my-workspace/assistant") {
      if (request.method() === "POST") {
        assistantCalls++;
        const body = request.postDataJSON();
        assistant.messages.push(
          { id: "question", role: "user", text: body.message },
          {
            id: "reply",
            role: "assistant",
            text: "已整理为日程草稿，请核对后加入日程。",
            responseModel: "openai/gpt-6.1-sol",
            schedules: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                title: "选款评审",
                date: "2026-10-27",
                startTime: "15:00",
                endTime: "16:00",
                note: "确认新品款式",
              },
            ],
            tools: ["products"],
          },
        );
        assistant.version++;
        submitted.push(body);
      }
      data = assistant;
    }
    if (path === "/my-workspace/activity")
      data = { items: activities, serverTime: "2026-10-26T02:00:00Z" };
    if (path === "/analytics/compass/ai-settings") settingsReads++;
    if (path === "/analytics/compass/ai-report") {
      reads++;
      data = report;
    }
    if (path === "/analytics/compass/ai-generate") {
      generates++;
      submitted.push(request.postDataJSON());
      Object.assign(
        report,
        generates === 1
          ? { state: "FAILED", message: "模型服务暂时不可用，请稍后重试" }
          : {
              state: "READY",
              message: undefined,
              content: {
                summary: "重试已完成，本批报表分析可用。",
                actions: [],
                observations: [],
                risks: [],
              },
            },
      );
      data = report;
    }
    await route.fulfill({ json: { data } });
  });
  return {
    report,
    reads: () => reads,
    generates: () => generates,
    settingsReads: () => settingsReads,
    submitted,
    workspace,
    activities,
    assistantCalls: () => assistantCalls,
  };
}

test("工作台只保留个人助理，不再读取经营报告或显示专属工具", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  await expect(
    page.getByRole("button", { name: "打开个人助理", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("专属 AI 工具")).toHaveCount(0);
  await expect(page.getByLabel("经营分析任务")).toHaveCount(0);
  expect(fixture.reads()).toBe(0);
  expect(fixture.generates()).toBe(0);
  expect(fixture.settingsReads()).toBe(0);
});

test("小序全站自由悬浮，拖动后记住位置，跨页面确认日程不自动保存", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  const companion = page.locator(".workspace-companion");
  await expect(
    companion.getByRole("button", { name: "打开 AI 个人助理", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".sidebar .sidebar-assistant")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("companion-workspace-dark.png"),
    fullPage: false,
  });
  const handle = companion.getByRole("button", {
    name: "打开 AI 个人助理",
    exact: true,
  });
  const before = (await handle.boundingBox())!;
  await page.mouse.move(before.x + 65, before.y + 60);
  await page.mouse.down();
  await page.mouse.move(100, 630, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("dialog", { name: /AI 个人助理/ })).toHaveCount(
    0,
  );
  const moved = (await companion.boundingBox())!;
  expect(moved.x).toBeLessThan(200);
  expect(moved.y).toBeGreaterThan(400);
  await page.reload();
  await expect(companion).toBeVisible();
  expect(Math.abs((await companion.boundingBox())!.x - moved.x)).toBeLessThan(
    2,
  );
  await companion.getByRole("button", { name: "展开小序状态与动态" }).click();
  await page.getByRole("button", { name: "复位助理位置" }).click();
  await expect(companion).toBeVisible();
  await expect(companion).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(
    companion.locator(
      ".companion-grid, .companion-shadow, .companion-placement",
    ),
  ).toHaveCount(0);
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  const sidebar = page.locator(".workspace-companion .sidebar-assistant");
  await expect(sidebar).toBeVisible();
  await expect(page.locator(".workspace-companion")).toHaveCount(1);
  await expect(page.locator(".sidebar .sidebar-assistant")).toHaveCount(0);
  await sidebar
    .getByRole("button", { name: "打开 AI 个人助理", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await dialog
    .getByPlaceholder(/告诉我你想完成什么/)
    .fill("安排明天下午3点选款会");
  await dialog.getByPlaceholder(/告诉我你想完成什么/).press("Enter");
  await dialog
    .getByRole("button", { name: "加入日程草稿", exact: true })
    .click();
  await expect(page).toHaveURL(/\/my-workspace$/);
  await expect(
    dialog.getByRole("button", { name: "已加入日程草稿", exact: true }),
  ).toBeDisabled();
  expect(fixture.workspace.schedule).toHaveLength(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "保存工作台", exact: true }).click();
  await expect.poll(() => fixture.workspace.schedule.length).toBe(1);
  expect(fixture.assistantCalls()).toBe(1);
});

test("动态面板显示真实任务进度、筛选和已读，浏览与招呼不调用模型", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  fixture.activities.push(
    {
      id: "schedule:1",
      kind: "schedule",
      title: "今日选款会",
      detail: "10:20–11:00",
      href: "/my-workspace",
      at: "2026-10-26T02:20:00Z",
      status: "attention",
    },
    {
      id: "compass:1",
      kind: "task",
      title: "罗盘报表更新",
      detail: "采集中",
      href: "/analytics/compass",
      at: "2026-10-26T01:59:00Z",
      status: "running",
      progress: { done: 1, total: 3 },
    },
    {
      id: "project:1",
      kind: "project",
      title: "新品项目",
      detail: "已验收 2 / 4 项任务",
      href: "/projects/1",
      at: "2026-10-26T01:00:00Z",
      status: "info",
      progress: { done: 2, total: 4 },
    },
  );
  await page.goto("/operations");
  const mascot = page.locator(".sidebar-assistant");
  await expect(mascot).toHaveAttribute("data-state", "working");
  await mascot.getByRole("button", { name: "展开小序状态与动态" }).click();
  await page.getByRole("button", { name: "查看助理动态反馈" }).click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(
    dialog.getByRole("progressbar", { name: "罗盘报表更新进度" }),
  ).toHaveAttribute("aria-valuenow", "1");
  await dialog.getByText("项目", { exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: "项目", exact: true }),
  ).toBeChecked();
  await expect(dialog.getByText("新品项目", { exact: true })).toBeVisible();
  await expect(dialog.getByText("罗盘报表更新", { exact: true })).toHaveCount(
    0,
  );
  await dialog.getByRole("button", { name: "这些动态我已看过" }).click();
  fixture.activities[1].status = "completed";
  fixture.activities[1].progress = { done: 3, total: 3 };
  await dialog.getByRole("button", { name: "刷新助理动态" }).click();
  await expect(mascot).toHaveAttribute("data-state", "notice");
  await dialog.getByRole("button", { name: "这些动态我已看过" }).click();
  await expect(mascot).toHaveAttribute("data-state", "idle");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await mascot.getByRole("button", { name: "展开小序状态与动态" }).click();
  await page.getByRole("button", { name: "和小序打个招呼" }).click();
  await expect(mascot).toHaveAttribute("data-state", "happy");
  expect(fixture.assistantCalls()).toBe(0);
  await page.screenshot({
    path: test.info().outputPath("companion-sidebar-dark.png"),
    fullPage: false,
  });
});

test("日程可添加编辑删除，保存后跨页面恢复，拒绝无效时间", async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "新增日程", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "新增日程", exact: true });
  await dialog.getByLabel("日程名称", { exact: true }).fill("供应商选款会");
  await dialog.getByLabel("日程日期", { exact: true }).fill("2026-11-02");
  await dialog.getByRole("switch", { name: "全天安排" }).click();
  await dialog.getByLabel("日程开始时间").fill("15:00");
  await dialog.getByLabel("日程结束时间").fill("14:00");
  await dialog.getByRole("button", { name: "应用日程" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "结束时间须晚于开始时间",
  );
  await dialog.getByLabel("日程结束时间").fill("16:00");
  await dialog.getByRole("button", { name: "应用日程" }).click();
  await expect(
    page.getByRole("button", { name: "编辑日程 供应商选款会" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存工作台", exact: true }).click();
  await expect(
    page.getByText("个人工作台已保存", { exact: true }),
  ).toBeVisible();
  await page.reload();
  expect(fixture.workspace.schedule).toHaveLength(1);
  await page.getByRole("button", { name: "日程下个月" }).click();
  await expect(page.locator(".schedule-month > strong")).toHaveText(
    "2026 年 11 月",
  );
  await page
    .getByRole("button", { name: "2026-11-02，1项日程", exact: true })
    .click();
  await page.getByRole("button", { name: "编辑日程 供应商选款会" }).click();
  dialog = page.getByRole("dialog", { name: "编辑日程", exact: true });
  await dialog.getByLabel("日程名称", { exact: true }).fill("新品评审会");
  await dialog.getByRole("button", { name: "应用日程" }).click();
  await page.getByRole("button", { name: "编辑日程 新品评审会" }).click();
  await page.getByRole("button", { name: "删除日程", exact: true }).click();
  await page.getByRole("button", { name: "保存工作台", exact: true }).click();
  await expect.poll(() => fixture.workspace.schedule.length).toBe(0);
});

test("个人助理仅发送后调用模型，日程须确认且可随账号保存", async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(
    dialog.getByRole("checkbox", { name: "附带已保存日程与待办" }),
  ).not.toBeChecked();
  expect(fixture.assistantCalls()).toBe(0);
  await dialog
    .getByPlaceholder(/告诉我你想完成什么/)
    .fill("帮我安排明天下午三点的选款评审");
  await dialog.getByPlaceholder(/告诉我你想完成什么/).press("Enter");
  await expect(
    dialog.getByText("已整理为日程草稿，请核对后加入日程。"),
  ).toBeVisible();
  expect(fixture.workspace.schedule).toHaveLength(0);
  expect(fixture.submitted[0]).toMatchObject({ includePersonalContext: false });
  expect(JSON.stringify(fixture.submitted)).not.toContain("仅自己的备忘");
  await dialog
    .getByRole("button", { name: "加入日程草稿", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "已加入日程草稿", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "保存工作台", exact: true }).click();
  await expect.poll(() => fixture.workspace.schedule.length).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  await expect(dialog.getByText("实际返回：openai/gpt-6.1-sol")).toBeVisible();
  expect(fixture.assistantCalls()).toBe(1);
});

test("没有分析权限不请求分析接口，也不显示商品 AI 工具", async ({ page }) => {
  const fixture = await workspaceFixture(page, {
    permissions: ["supply.portal"],
  });
  await page.goto("/my-workspace");
  await expect(page.getByLabel("私有备忘", { exact: true })).toBeVisible();
  await expect(page.locator(".workspace-ai")).toHaveCount(0);
  expect(fixture.reads()).toBe(0);
  expect(fixture.settingsReads()).toBe(0);
});

test("手机工作台不横向溢出，减少动态效果时关闭流光", async ({ page }) => {
  await workspaceFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace");
  await expect(
    page.getByRole("button", { name: "打开个人助理", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".magic-border-beam")).toHaveCSS(
    "overflow",
    "hidden",
  );
  const size = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(size.content).toBeLessThanOrEqual(size.viewport + 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".magic-border-beam")).toHaveCSS("display", "none");
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "发送给个人助理" }),
  ).toBeVisible();
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390.05);
});

test("手机导航可开关，助理和日程弹窗完整显示且业务页面沿用全站主题", async ({
  page,
}) => {
  await workspaceFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace");
  await page
    .getByRole("button", { name: "展开工作区导航", exact: true })
    .click();
  await expect(
    page.locator(".sidebar").getByRole("link", { name: "运营中心" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "关闭工作区导航", exact: true })
    .click();
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  const assistant = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(
    assistant.getByRole("button", { name: "发送给个人助理" }),
  ).toBeVisible();
  expect((await assistant.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  await assistant.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "新增日程", exact: true }).click();
  const calendar = page.getByRole("dialog", { name: "新增日程", exact: true });
  await expect(calendar.getByLabel("日程名称", { exact: true })).toBeVisible();
  expect((await calendar.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  await calendar.getByRole("button", { name: "取消", exact: true }).click();
  await expect(calendar).not.toBeVisible();
  await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("workspace-future-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "展开工作区导航", exact: true })
    .click();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  await expect(page).toHaveURL(/\/operations$/);
  await expect(page.locator(".workspace-future")).toHaveCount(0);
});
test("小序空闲游动，输入与减少动态效果暂停，角标点击展开反馈", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.clock.install({ time: new Date("2026-10-26T02:00:00Z") });
  fixture.activities.push({
    id: "project:new",
    kind: "project",
    title: "新品进度更新",
    detail: "已验收 2 / 4 项",
    href: "/projects/1",
    at: "2026-10-26T02:00:00Z",
    status: "info",
  });
  await page.goto("/my-workspace");
  const companion = page.locator(".workspace-companion");
  await expect(companion).toBeVisible();
  const badge = companion.getByRole("button", { name: "展开小序状态与动态" });
  await expect(badge).toHaveText("1");
  await expect(
    page.getByRole("button", { name: "查看助理动态反馈" }),
  ).toHaveCount(0);
  const before = (await companion.boundingBox())!;
  await page.mouse.move(5, 5);
  await page.clock.runFor(42000);
  const after = (await companion.boundingBox())!;
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(
    15,
  );
  const input = page.getByPlaceholder(/告诉我你想完成什么/);
  await input.fill("正在输入");
  const paused = await companion.boundingBox();
  await page.clock.runFor(35000);
  expect(await companion.boundingBox()).toEqual(paused);
  await page.getByRole("heading", { level: 1 }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await companion.boundingBox();
  await page.clock.runFor(35000);
  expect(await companion.boundingBox()).toEqual(reduced);
  await badge.click();
  await expect(badge).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("button", { name: "查看助理动态反馈" }),
  ).toBeVisible();
  await page.getByRole("heading", { level: 1 }).click();
  await expect(badge).toHaveAttribute("aria-expanded", "false");
  expect(fixture.assistantCalls()).toBe(0);
});

test("格子与代码没有遮罩或助理压暗，手机完整显示", async ({ page }) => {
  await workspaceFixture(page);
  await page.goto("/my-workspace");
  const matrix = page.locator(".workspace-matrix");
  await expect(matrix).toHaveCSS("mask-image", "none");
  await expect(matrix).toHaveCSS("opacity", "1");
  await expect(matrix.locator(".workspace-matrix-cell")).toHaveCount(168);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(matrix).toHaveCSS("mask-image", "none");
  await expect(matrix).toHaveCSS("opacity", "1");
  const rect = (await matrix.boundingBox())!;
  expect(rect.x).toBeGreaterThan(0);
  expect(rect.x + rect.width).toBeLessThan(390);
  expect(rect.y + rect.height).toBeLessThan(
    (await page.locator(".workspace-ai-intro").boundingBox())!.y,
  );
});

test("新提醒短文字输出后收起，历史记录不反复播报", async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.clock.install({ time: new Date("2026-10-26T02:00:00Z") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  fixture.activities.push({
    id: "task:old",
    kind: "task",
    title: "昨天的报表更新",
    detail: "已完成",
    href: "/analytics/compass",
    at: "2026-10-25T02:00:00Z",
    status: "completed",
  });
  await page.goto("/operations");
  const companion = page.locator(".workspace-companion");
  await expect(
    companion.getByRole("button", { name: "展开小序状态与动态" }),
  ).toHaveText("1");
  await expect(companion.locator(".companion-reminder")).toHaveCount(0);
  fixture.activities.push({
    id: "schedule:due",
    kind: "schedule",
    title: "选款会即将开始",
    detail: "10:30 开始，请准备样衣和款式资料",
    href: "/my-workspace",
    at: "2026-10-26T02:30:00Z",
    status: "attention",
  });
  await page.clock.runFor(31000);
  const reminder = companion.locator(".companion-reminder");
  await expect(reminder).toContainText("选款会即将开始");
  expect((await reminder.textContent())!.length).toBeLessThanOrEqual(32);
  await expect(
    page.getByRole("button", { name: "查看助理动态反馈" }),
  ).toHaveCount(0);
  await page.clock.runFor(8500);
  await expect(reminder).toHaveCount(0);
  await page.clock.runFor(31000);
  await expect(reminder).toHaveCount(0);
  expect(fixture.assistantCalls()).toBe(0);
});
