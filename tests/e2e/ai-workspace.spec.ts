import { expect, test, type Page } from "@playwright/test";
import type { AssistantActivity } from "../../packages/contracts/src/assistant-activity.js";

type VoiceFixture = {
  starts: number;
  aborts: number;
  spoken: string[];
  canceled: number;
  recognizer?: {
    onresult?: (event: unknown) => void;
    onerror?: (event: unknown) => void;
  };
};
declare global {
  interface Window {
    assistantVoiceTest: VoiceFixture;
  }
}
async function mockBrowserVoice(page: Page, supported = true) {
  await page.addInitScript(
    ({ supported }) => {
      const stats: VoiceFixture = {
        starts: 0,
        aborts: 0,
        spoken: [],
        canceled: 0,
      };
      window.assistantVoiceTest = stats;
      class Recognizer {
        onresult?: (event: unknown) => void;
        onerror?: (event: unknown) => void;
        start() {
          stats.starts++;
          stats.recognizer = this;
        }
        abort() {
          stats.aborts++;
        }
      }
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: supported ? Recognizer : undefined,
      });
      Object.defineProperty(window, "webkitSpeechRecognition", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          getVoices: () => [],
          cancel: () => {
            stats.canceled++;
          },
          speak: (utterance: SpeechSynthesisUtterance) => {
            stats.spoken.push(utterance.text);
            utterance.onstart?.call(utterance, {} as SpeechSynthesisEvent);
          },
        },
      });
    },
    { supported },
  );
}

test("语音输入须主动启动，转写可编辑，关闭停止麦克风", async ({ page }) => {
  await mockBrowserVoice(page);
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  expect(await page.evaluate(() => window.assistantVoiceTest.starts)).toBe(0);
  await dialog.getByRole("button", { name: "语音输入", exact: true }).click();
  await expect(page.locator(".sidebar-assistant")).toHaveAttribute(
    "data-state",
    "listening",
  );
  await page.evaluate(() =>
    window.assistantVoiceTest.recognizer?.onresult?.({
      results: [{ isFinal: true, 0: { transcript: "安排明天选款会" } }],
    }),
  );
  const input = dialog.getByPlaceholder(/告诉我你想完成什么/);
  await expect(input).toHaveValue("安排明天选款会");
  expect(fixture.assistantCalls()).toBe(0);
  await dialog.getByRole("button", { name: "停止语音输入" }).click();
  await input.fill("安排明天下午3点选款会");
  await input.press("Enter");
  await expect.poll(() => fixture.assistantCalls()).toBe(1);
  await expect(
    dialog.getByText("已整理为日程草稿，请核对后加入日程。", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.assistantVoiceTest.spoken)).toEqual(
    [],
  );
  await dialog.getByRole("button", { name: "语音输入", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.assistantVoiceTest.aborts))
    .toBe(2);
  await expect(page.locator(".sidebar-assistant")).not.toHaveAttribute(
    "data-state",
    "listening",
  );
});

test("语音不可用时保留文字输入；识别服务拒绝时显示原因", async ({ page }) => {
  await mockBrowserVoice(page, false);
  await workspaceFixture(page);
  await page.goto("/my-workspace");
  await expect(
    page.getByRole("button", { name: "语音输入", exact: true }),
  ).toBeDisabled();
  await expect(page.getByPlaceholder(/告诉我你想完成什么/)).toBeEditable();
});

test("新提醒播报须开启，旧提醒不重播，识别权限错误可继续键入", async ({
  page,
}) => {
  await mockBrowserVoice(page);
  const fixture = await workspaceFixture(page);
  fixture.activities.push({
    id: "schedule:old",
    kind: "schedule",
    title: "原有日程",
    detail: "即将开始",
    status: "attention",
    at: "2026-10-26T02:10:00Z",
    href: "/my-workspace",
  });
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await dialog.getByRole("checkbox", { name: "播报新提醒" }).check();
  expect(
    await page.evaluate(() => window.assistantVoiceTest.spoken.length),
  ).toBe(0);
  await dialog.getByRole("tab", { name: "动态反馈" }).click();
  fixture.activities.push({
    id: "schedule:new",
    kind: "schedule",
    title: "新的选款会",
    detail: "10:20开始",
    status: "attention",
    at: "2026-10-26T02:20:00Z",
    href: "/my-workspace",
  });
  await dialog.getByRole("button", { name: "刷新助理动态" }).click();
  await expect
    .poll(() => page.evaluate(() => window.assistantVoiceTest.spoken))
    .toEqual(["新的选款会：10:20开始"]);
  await dialog.getByRole("tab", { name: "互动对话" }).click();
  await dialog.getByRole("button", { name: "语音输入", exact: true }).click();
  await page.evaluate(() =>
    window.assistantVoiceTest.recognizer?.onerror?.({ error: "not-allowed" }),
  );
  await expect(dialog.getByText(/麦克风权限未开启/)).toBeVisible();
  await expect(dialog.getByPlaceholder(/告诉我你想完成什么/)).toBeEditable();
});

test("个人记忆独立保存编辑删除，发送时明确选择是否使用", async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await dialog.getByRole("tab", { name: "个人记忆" }).click();
  await dialog.getByRole("button", { name: "新增记忆" }).click();
  await dialog.getByLabel("记忆名称", { exact: true }).fill("汇报偏好");
  await dialog
    .getByLabel("记忆内容", { exact: true })
    .fill("先说结论，金额保留两位小数");
  await dialog.getByRole("button", { name: "保存记忆" }).click();
  await expect(dialog.locator(".assistant-memory-entry")).toContainText(
    "汇报偏好",
  );
  expect(fixture.assistantCalls()).toBe(0);
  expect(fixture.memoryWrites).toHaveLength(1);
  await dialog.getByRole("button", { name: "编辑记忆", exact: true }).click();
  await dialog
    .getByLabel("记忆内容", { exact: true })
    .fill("先列风险，再列行动");
  await dialog.getByRole("button", { name: "保存记忆" }).click();
  await expect(dialog.locator(".assistant-memory-entry")).toContainText(
    "先列风险",
  );
  await dialog.getByRole("tab", { name: "互动对话" }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "使用个人记忆" }),
  ).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: "使用个人记忆" }).check();
  await dialog
    .getByPlaceholder(/告诉我你想完成什么/)
    .fill("帮我安排明天的会议");
  await dialog.getByPlaceholder(/告诉我你想完成什么/).press("Enter");
  await expect.poll(() => fixture.submitted.length).toBe(1);
  expect(fixture.submitted[0]).toMatchObject({ includeMemory: true });
  await dialog.getByRole("tab", { name: "个人记忆" }).click();
  await dialog.getByRole("button", { name: "删除记忆", exact: true }).click();
  await page.getByRole("button", { name: "删除", exact: true }).last().click();
  await expect(
    dialog.getByText("还没有个人记忆", { exact: true }),
  ).toBeVisible();
  expect(fixture.memory.entries).toHaveLength(0);
});

test("查询证据保留条码；操作卡点击后提交，完成以真实动态为准", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  fixture.assistant.messages.push({
    id: "business-reply",
    role: "assistant",
    text: "已查到库存快照。需要更新时请点击下面的操作。",
    responseModel: "openai/gpt-6.1-sol",
    evidence: [
      {
        id: "evidence",
        title: "库存查询 · XFA16X31196L",
        ok: true,
        at: "2026-11-01T08:00:00Z",
        summary: "杭州总仓 · 来源时间 2026-11-01 · 实际库存15件",
        rows: [
          {
            label: "粉色 L · 000123456789012345678901234",
            value: "实际库存 15 · 销退仓 数据不完整",
          },
        ],
      },
    ],
    actions: [
      {
        id: "action",
        kind: "compass",
        title: "更新罗盘报表",
        status: "PROPOSED",
        note: "尚未执行，点击后提交后台任务",
        href: "/analytics/compass",
        canExecute: true,
      },
    ],
  });
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await dialog.locator(".assistant-evidence summary").click();
  await expect(dialog.getByText(/000123456789012345678901234/)).toBeVisible();
  const action = dialog.getByRole("article", { name: "更新罗盘报表操作" });
  expect(fixture.actionWrites).toHaveLength(0);
  await action.getByRole("button", { name: "开始执行" }).click();
  await expect(action.getByText("已提交", { exact: true })).toBeVisible();
  await expect(action.getByRole("button", { name: "开始执行" })).toHaveCount(0);
  await expect(action.getByText("已完成", { exact: true })).toHaveCount(0);
  expect(fixture.actionWrites).toHaveLength(1);
  fixture.activities.push({
    id: "compass:9",
    kind: "task",
    title: "罗盘报表更新",
    detail: "三张报表已完整核验",
    status: "completed",
    href: "/analytics/compass",
    at: "2026-11-01T08:00:00Z",
  });
  await dialog.getByRole("tab", { name: "动态反馈" }).click();
  await dialog.getByRole("button", { name: "刷新助理动态" }).click();
  await dialog.getByRole("tab", { name: "互动对话" }).click();
  await expect(action.getByText("已完成", { exact: true })).toBeVisible();
  await page.clock.runFor(4000);
  await page.screenshot({
    path: test.info().outputPath("assistant-business-dark.png"),
  });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "切换为亮色主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  await expect(dialog.getByRole("tab", { name: "互动对话" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog).toBeInViewport({ ratio: 0.99 });
  await page.screenshot({
    path: test.info().outputPath("assistant-business-light.png"),
  });
});

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
    settingsReads = 0,
    contentReads = 0;
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
  const memory: Record<string, any> = { version: 0, entries: [] };
  const appearance = { mode: "dark", version: 0 };
  const memoryWrites: unknown[] = [],
    actionWrites: unknown[] = [];
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
    if (path === "/my-workspace/appearance") {
      if (request.method() === "POST")
        Object.assign(appearance, {
          mode: request.postDataJSON().mode,
          version: appearance.version + 1,
        });
      data = appearance;
    }
    if (path === "/my-workspace") {
      if (request.method() === "POST")
        Object.assign(workspace, request.postDataJSON(), {
          version: workspace.version + 1,
        });
      data = workspace;
    }
    if (path === "/my-workspace/content") {
      contentReads++;
      data = { items: [], hasMore: false };
    }
    if (path === "/my-workspace/assistant") {
      if (request.method() === "POST") {
        assistantCalls++;
        const body = request.postDataJSON();
        assistant.messages.push(
          {
            id: "question-" + assistantCalls,
            role: "user",
            text: body.message,
          },
          {
            id: "reply-" + assistantCalls,
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
    if (path === "/my-workspace/assistant/memory") {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        memoryWrites.push(body);
        Object.assign(memory, {
          version: memory.version + 1,
          entries: body.entries,
        });
      }
      data = memory;
    }
    if (path === "/my-workspace/assistant/actions") {
      actionWrites.push(request.postDataJSON());
      const action = assistant.messages
        .flatMap((item: any) => item.actions || [])
        .find((item: any) => item.id === request.postDataJSON().id);
      Object.assign(action, {
        status: "SUBMITTED",
        jobId: "9",
        note: "已提交后台任务，进度请查看动态反馈",
      });
      data = action;
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
    contentReads: () => contentReads,
    submitted,
    workspace,
    activities,
    assistant,
    memory,
    memoryWrites,
    actionWrites,
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

test("工作台面板默认收起，切换与重开保留草稿且只在保存后同步", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  await expect(
    page.getByRole("button", { name: "打开个人待办", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("待办事项", { exact: true })).not.toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "私有备忘", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "新增日程", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "打开个人待办", exact: true }).click();
  await page.getByLabel("待办事项", { exact: true }).fill("整理新品资料");
  await page.getByLabel("待办截止日期", { exact: true }).fill("2026-10-28");
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.getByRole("button", { name: "打开私有备忘", exact: true }).click();
  await page
    .getByRole("textbox", { name: "私有备忘", exact: true })
    .fill("保留在草稿中的评审要点");
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.getByRole("button", { name: "打开个人待办", exact: true }).click();
  await expect(page.getByLabel("待办事项", { exact: true })).toHaveValue(
    "整理新品资料",
  );
  await expect(page.getByLabel("待办截止日期", { exact: true })).toHaveValue(
    "2026-10-28",
  );
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  expect(fixture.workspace.todos).toEqual([]);
  expect(fixture.workspace.note).toBe("仅自己的备忘，不发送给模型");
  await page.getByRole("button", { name: "打开私有备忘", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "私有备忘", exact: true }),
  ).toHaveValue("保留在草稿中的评审要点");
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.getByRole("button", { name: "保存工作台", exact: true }).click();
  await expect.poll(() => fixture.workspace.todos.length).toBe(1);
  expect(fixture.workspace.note).toBe("保留在草稿中的评审要点");
  await page.reload();
  await page.getByRole("button", { name: "打开个人待办", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "整理新品资料", exact: true }),
  ).toBeVisible();
  expect(fixture.assistantCalls()).toBe(0);
});

test("我的内容在首次展开时才读取，关闭后保留分类与显示样式", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page, {
    permissions: ["project.read", "analytics.read", "analytics.manage"],
  });
  await page.goto("/my-workspace");
  await expect(
    page.getByRole("button", { name: "打开我的内容", exact: true }),
  ).toBeVisible();
  expect(fixture.contentReads()).toBe(0);
  await page.getByRole("button", { name: "打开常用工具", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "常用工具", exact: true }),
  ).toBeVisible();
  expect(fixture.contentReads()).toBe(0);
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.getByRole("button", { name: "打开我的内容", exact: true }).click();
  await expect.poll(() => fixture.contentReads()).toBe(1);
  await page.getByRole("tab", { name: "表格", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "我的内容显示样式" })
    .getByText("列表", { exact: true })
    .click();
  await expect.poll(() => fixture.contentReads()).toBe(2);
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.getByRole("button", { name: "打开日程", exact: true }).click();
  await page.getByRole("button", { name: "日程下个月", exact: true }).click();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.getByRole("button", { name: "打开我的内容", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "表格", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page
      .getByRole("radiogroup", { name: "我的内容显示样式" })
      .getByRole("radio", { name: /列表$/ }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.getByRole("button", { name: "打开日程", exact: true }).click();
  await expect(page.locator(".schedule-month > strong")).toHaveText(
    "2026 年 11 月",
  );
  expect(fixture.assistantCalls()).toBe(0);
});

test("小序全站自由悬浮，拖动后记住位置，跨页面确认日程不自动保存", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  const companion = page.locator(".workspace-companion");
  await expect(
    companion.getByRole("button", { name: "与小序语音对话", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".sidebar .sidebar-assistant")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("companion-workspace-dark.png"),
    fullPage: false,
  });
  const handle = companion.getByRole("button", {
    name: "与小序语音对话",
    exact: true,
  });
  const before = (await handle.boundingBox())!;
  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(100, 630, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("dialog", { name: /AI 个人助理/ })).toHaveCount(
    0,
  );
  const moved = (await companion.boundingBox())!;
  expect(moved.x).toBeLessThan(200);
  // The mascot may move away from the requested drop point to avoid controls.
  expect(Math.hypot(moved.x - before.x, moved.y - before.y)).toBeGreaterThan(
    80,
  );
  expect(moved.y).toBeGreaterThanOrEqual(8);
  expect(moved.y + moved.height).toBeLessThanOrEqual(1000);
  await page.reload();
  await expect(companion).toBeVisible();
  expect(Math.abs((await companion.boundingBox())!.x - moved.x)).toBeLessThan(
    2,
  );
  await companion.getByRole("button", { name: "展开小序状态与动态" }).click();
  await expect(page.getByRole("button", { name: "复位助理位置" })).toHaveCount(
    0,
  );
  await companion
    .getByRole("button", { name: "展开小序状态与动态" })
    .press("Escape");
  await companion.locator(".companion-launch").press("Home");
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
  await sidebar.getByRole("button", { name: "展开小序状态与动态" }).click();
  await page.getByRole("button", { name: "文字对话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await dialog
    .getByPlaceholder(/告诉我你想完成什么/)
    .fill("安排明天下午3点选款会");
  await dialog.getByPlaceholder(/告诉我你想完成什么/).press("Enter");
  await dialog
    .getByRole("button", { name: "加入日程草稿", exact: true })
    .click();
  await expect(page).toHaveURL(/\/my-workspace$/);
  expect(fixture.workspace.schedule).toHaveLength(0);
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "日程", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect.poll(() => fixture.workspace.schedule.length).toBe(1);
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "已加入日程草稿", exact: true }),
  ).toBeDisabled();
  expect(fixture.assistantCalls()).toBe(1);
});

test("动态面板显示真实任务进度、筛选和已读，展开入口不调用模型", async ({
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
  await expect(
    page.getByRole("button", { name: "和小序打个招呼" }),
  ).toHaveCount(0);
  await expect(page.locator(".companion-interactions button")).toHaveCount(3);
  await expect(mascot).toHaveAttribute("data-state", "idle");
  expect(fixture.assistantCalls()).toBe(0);
  await page.screenshot({
    path: test.info().outputPath("companion-sidebar-dark.png"),
    fullPage: false,
  });
});

test("日程可添加编辑删除，保存后跨页面恢复，拒绝无效时间", async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "打开日程", exact: true }).click();
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
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(
    page.getByText("个人工作台已保存", { exact: true }),
  ).toBeVisible();
  await page.reload();
  expect(fixture.workspace.schedule).toHaveLength(1);
  await page.getByRole("button", { name: "打开日程", exact: true }).click();
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
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
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
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "日程", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect.poll(() => fixture.workspace.schedule.length).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  await expect(dialog.getByText(/实际返回：|openai\/gpt/i)).toHaveCount(0);
  await expect(
    dialog.getByText("已整理为日程草稿，请核对后加入日程。"),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "已加入日程草稿", exact: true }),
  ).toBeDisabled();
  expect(fixture.assistantCalls()).toBe(1);
});

test("无个人助理权限仍可使用私有记录与已有权限工具", async ({ page }) => {
  const fixture = await workspaceFixture(page, {
    permissions: ["inventory.read"],
  });
  fixture.workspace.shortcuts = ["inventory"];
  fixture.workspace.available = fixture.workspace.available.filter(
    (tool: { id: string }) => tool.id === "inventory",
  );
  await page.goto("/my-workspace");
  await expect(page.locator(".workspace-ai")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "打开我的内容", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "打开私有备忘", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "私有备忘", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.getByRole("button", { name: "打开个人待办", exact: true }).click();
  await page.getByLabel("待办事项", { exact: true }).fill("核对库存");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "核对库存", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.getByRole("button", { name: "打开常用工具", exact: true }).click();
  const tools = page.getByRole("dialog", { name: "常用工具", exact: true });
  await expect(tools.getByRole("link", { name: /库存明细/ })).toBeVisible();
  await expect(tools.getByRole("link", { name: /经营分析/ })).toHaveCount(0);
  expect(fixture.reads()).toBe(0);
  expect(fixture.settingsReads()).toBe(0);
  expect(fixture.assistantCalls()).toBe(0);
  expect(fixture.contentReads()).toBe(0);
});

test("手机工作台与收起面板不横向溢出，减少动态效果时核心保持静态", async ({
  page,
}) => {
  await workspaceFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace");
  await expect(
    page.getByRole("button", { name: "打开个人助理", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".workspace-ai-core")).toBeVisible();
  const size = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(size.content).toBeLessThanOrEqual(size.viewport + 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const animations = await page.locator(".workspace-ai-core").evaluate((core) =>
    [core, ...core.querySelectorAll("*")].flatMap((element) =>
      [undefined, "::before", "::after"].map((pseudo) => {
        const style = getComputedStyle(element, pseudo);
        return { name: style.animationName, duration: style.animationDuration };
      }),
    ),
  );
  expect(
    animations.every(
      ({ name, duration }) =>
        name === "none" ||
        duration.split(",").every((value) => parseFloat(value) <= 0.01),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "发送给个人助理" }),
  ).toBeVisible();
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "打开个人待办", exact: true }).click();
  const todo = page.getByRole("dialog", { name: "个人待办", exact: true });
  await expect(todo.getByLabel("待办事项", { exact: true })).toBeVisible();
  expect((await todo.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(391);
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
  await page.getByRole("button", { name: "打开日程", exact: true }).click();
  await page.getByRole("button", { name: "新增日程", exact: true }).click();
  const calendar = page.getByRole("dialog", { name: "新增日程", exact: true });
  await expect(calendar.getByLabel("日程名称", { exact: true })).toBeVisible();
  expect((await calendar.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  await calendar.getByRole("button", { name: "取消", exact: true }).click();
  await expect(calendar).not.toBeVisible();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
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

test("中心AI核心在桌面与手机完整显示，页面打开不调用模型", async ({ page }) => {
  const fixture = await workspaceFixture(page, {
    permissions: [
      "analytics.read",
      "analytics.manage",
      "product.read",
      "product.update",
      "selection.read",
      "selection.manage",
      "inventory.read",
      "project.read",
    ],
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/my-workspace");
  const core = page.locator(".workspace-ai-core");
  await expect(core).toBeVisible();
  await expect(page.locator(".workspace-ai")).toHaveAttribute(
    "data-core-state",
    "idle",
  );
  const desktop = (await core.boundingBox())!;
  expect(desktop.x).toBeGreaterThanOrEqual(0);
  expect(desktop.x + desktop.width).toBeLessThanOrEqual(1440);
  const dock = page.getByRole("navigation", { name: "工作台功能面板" });
  await expect(dock).toBeInViewport({ ratio: 1 });
  const dockBounds = (await dock.boundingBox())!;
  expect(dockBounds.y + dockBounds.height).toBeLessThanOrEqual(1000);
  await page.screenshot({
    path: ".local/jarvis-workspace-dark.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "切换为亮色主题", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: ".local/jarvis-workspace-light.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "切换为暗色主题", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "打开日程", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "日程", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/jarvis-workspace-schedule.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(core).toBeVisible();
  const mobile = (await core.boundingBox())!;
  expect(mobile.x).toBeGreaterThanOrEqual(0);
  expect(mobile.x + mobile.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(391);
  await page.screenshot({
    path: ".local/jarvis-workspace-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(fixture.assistantCalls()).toBe(0);
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
