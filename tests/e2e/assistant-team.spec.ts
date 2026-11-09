import {
  openPersonalAssistant,
  selectAssistantPanel,
} from "./assistant-controls.js";
import { expect, test, type Page } from "@playwright/test";
import {
  defaultTeamSettings,
  type TeamConfiguration,
  type TeamRun,
  type TeamRunCreate,
  type TeamArtifact,
} from "../../packages/contracts/src/assistant-team.js";

const root = "/my-workspace/assistant/team";
const attachmentId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
async function setup(
  page: Page,
  options: {
    rejectSubmission?: boolean;
    saveConflict?: boolean;
    video?: boolean;
    deerflow?: boolean;
    ready?: boolean;
  } = {},
) {
  let configuration: TeamConfiguration = {
    ...defaultTeamSettings(),
    version: 1,
    ready: true,
    notice: "",
    models: [
      {
        id: "engine/fast",
        name: "快速模型",
        model: "qwen-flash",
        tier: "fast",
        vision: false,
        pdf: false,
        structured: true,
      },
      {
        id: "engine/strong",
        name: "推理模型",
        model: "qwen3-max",
        tier: "strong",
        vision: true,
        pdf: true,
        structured: true,
      },
    ],
    imageModels: [
      {
        id: "image/design",
        name: "图像设计",
        model: "wan-image",
        reference: true,
      },
    ],
    videoModels: options.video
      ? [
          {
            id: "video/generate",
            name: "视频生成",
            model: "wan-video",
            durations: [5],
            aspects: ["16:9"],
            minImages: 0,
            maxImages: 1,
            resolution: "720p",
          },
        ]
      : [],
  };
  if (options.deerflow) {
    configuration = {
      ...configuration,
      engine: "deerflow",
      ready: options.ready ?? true,
      notice:
        options.ready === false ? "团队服务连接尚未配置，请联系管理员。" : "",
      models: [],
      imageModels: [],
      videoModels: [],
    };
  }
  const submissions: TeamRunCreate[] = [],
    saves: TeamConfiguration[] = [],
    personal: unknown[] = [];
  let run: TeamRun | undefined,
    completed = false,
    canceled = false;
  const artifact: TeamArtifact = {
    id: artifactId,
    runId: "",
    stepId: "draft",
    memberId: "writing",
    attempt: 2,
    title: "已验收活动文案",
    kind: "text",
    content: "第二版文案：按目标与素材形成的最终正文。",
    fileIds: [],
    files: [],
    citations: [{ title: "素材来源", url: "https://example.com/source" }],
    status: "ACCEPTED",
    review: "信息与素材一致，字数及交付要求通过。",
    tags: ["活动文案"],
    createdAt: new Date().toISOString(),
  };
  if (options.deerflow) {
    Object.assign(artifact, {
      attempt: 1,
      title: "活动文案交付",
      content: "根据所附资料整理的活动文案。",
      status: "DRAFT",
      review: "",
    });
  }
  const currentRun = () =>
    run && {
      ...run,
      ...(canceled
        ? { status: "CANCELED" as const, stage: "任务已取消" }
        : completed
          ? {
              status: "DONE" as const,
              stage: options.deerflow ? "团队成果已返回" : "验收与归档完成",
              summary: options.deerflow
                ? "已整理活动文案，请核对交付内容。"
                : "任务已按验收要求完成，第二版已归档。",
              artifacts: [{ ...artifact, runId: run.id }],
              steps: run.steps.map((step) => ({
                ...step,
                status: "DONE" as const,
                attempts: 2,
                review: artifact.review,
                result: artifact.content,
                artifactIds: [artifact.id],
              })),
            }
          : {}),
    };
  await page.context().route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "7",
        username: "test",
        displayName: "测试用户",
        roleCodes: [],
        permissions: ["analytics.manage", "analytics.read"],
        csrfToken: "fixture",
      };
    else if (path === "/my-workspace/appearance")
      data = { mode: "dark", version: 1 };
    else if (path === "/my-workspace")
      data = {
        version: 1,
        note: "",
        todos: [],
        schedule: [],
        shortcuts: [],
        available: [],
        defaults: { name: "我的工作台", description: "", tools: [] },
      };
    else if (path === "/my-workspace/activity")
      data = { items: [], serverTime: new Date().toISOString() };
    else if (path === "/my-workspace/assistant/desktop")
      data = { devices: [], tasks: [] };
    else if (path === "/my-workspace/assistant/memory")
      data = { entries: [], version: 0 };
    else if (
      path === "/my-workspace/assistant/voice" ||
      path === "/my-workspace/assistant/realtime"
    )
      data = {
        ready: false,
        enabled: false,
        canManage: false,
        message: "语音尚未开启",
      };
    else if (path === "/my-workspace/assistant/capabilities")
      data = {
        defaultModel: "engine/fast",
        models: [{ id: "engine/fast", name: "通用助手", vision: true }],
        imageModels: [],
      };
    else if (
      path === "/my-workspace/assistant/files" &&
      request.method() === "POST"
    )
      data = {
        id: attachmentId,
        name: "素材.txt",
        mime: "text/plain",
        size: 20,
        source: "upload",
        createdAt: new Date().toISOString(),
      };
    else if (path === "/my-workspace/assistant") {
      if (request.method() === "POST") personal.push(request.postDataJSON());
      data = {
        ready: true,
        state: "IDLE",
        version: 0,
        messages: run
          ? [
              {
                id: run.id,
                role: "user",
                text: run.goal,
                source: "team",
                createdAt: run.createdAt,
              },
              {
                id: "reply-" + run.id,
                role: "assistant",
                text: currentRun()!.summary || currentRun()!.stage,
                teamRunId: run.id,
                source: "team",
                createdAt: run.createdAt,
              },
            ]
          : [],
        error: "",
        availabilityMessage: "已就绪",
      };
    } else if (path === root) {
      if (request.method() === "POST") {
        if (options.saveConflict) {
          await route.fulfill({
            status: 409,
            json: {
              error: { message: "团队配置已在其他窗口更新，请重新载入后保存" },
            },
          });
          return;
        }
        configuration = {
          ...configuration,
          ...request.postDataJSON(),
          version: configuration.version + 1,
        };
        saves.push(configuration);
      }
      data = configuration;
    } else if (path === `${root}/runs`) {
      if (request.method() === "POST") {
        const input = request.postDataJSON() as TeamRunCreate;
        submissions.push(input);
        if (options.rejectSubmission) {
          await route.fulfill({
            status: 503,
            json: { error: { message: "团队执行服务暂时不可用，请稍后重试" } },
          });
          return;
        }
        run = {
          id: input.id,
          engine: options.deerflow ? "deerflow" : "native",
          goal: input.goal,
          status: "RUNNING",
          stage: options.deerflow
            ? "团队正在处理资料"
            : "编剧正在根据素材生成第一版",
          plan: options.deerflow
            ? ""
            : "由主脑拆分目标，编剧创作，调度独立验收。",
          steps: options.deerflow
            ? []
            : [
                {
                  id: "draft",
                  title: "创作活动文案",
                  memberId: "writing",
                  instruction: "结合所附资料完成活动文案",
                  dependencies: [],
                  difficulty: "complex",
                  deliverable: "text",
                  acceptance: ["内容与资料一致", "交付完整正文"],
                  status: "RUNNING",
                  attempts: 1,
                  model: "qwen3-max",
                  modelId: "engine/strong",
                  routeReason: "复杂任务选择高能力模型",
                  jobIds: [],
                  artifactIds: [],
                },
              ],
          artifacts: [],
          summary: "",
          error: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          members: configuration.members,
        };
        data = run;
      } else data = run ? [currentRun()] : [];
    } else if (run && path === `${root}/runs/${run.id}`) data = currentRun();
    else if (run && path === `${root}/runs/${run.id}/cancel`) {
      canceled = true;
      data = {
        canceled: true,
        note: "已停止团队调度；已经提交的生成服务不保证远端停止。",
      };
    } else if (path === `${root}/library`)
      data =
        completed &&
        artifact.status === "ACCEPTED" &&
        (!url.searchParams.get("q") ||
          artifact.content.includes(url.searchParams.get("q")!) ||
          artifact.title.includes(url.searchParams.get("q")!))
          ? [artifact]
          : [];
    await route.fulfill({ json: { data } });
  });
  return {
    submissions,
    saves,
    personal,
    complete: () => {
      completed = true;
    },
    interrupt: (status: "FAILED" | "CANCELED" | "NEEDS_USER") => {
      if (run)
        run = {
          ...run,
          status,
          stage: "需要核对任务结果",
          error: status === "FAILED" ? "执行服务暂时不可用" : "",
        };
    },
  };
}

async function submitInWorkspace(page: Page) {
  await page.goto("/my-workspace");
  await page.getByRole("button", { name: "选择对话模型" }).click();
  await page.getByRole("menuitem", { name: /智能体团队/ }).click();
  await page
    .locator(".assistant-compose textarea")
    .fill("根据商品资料制作秋冬针织上新方案");
  await page.getByRole("button", { name: "提交团队任务" }).click();
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-status",
    "RUNNING",
  );
}

test("星轨展示真实协作、仅在新交付时汇聚、保留配色并可打开成果", async ({
  page,
}) => {
  const fixture = await setup(page);
  await submitInWorkspace(page);
  await expect(page.getByRole("dialog", { name: /AI 个人助理/ })).toBeHidden();
  await expect(page.locator(".team-orbit-node")).toHaveCount(6);
  await expect(
    page.getByRole("button", { name: "查看团队成员：编剧" }),
  ).toContainText("正在执行");
  await expect(
    page.getByRole("button", { name: "查看团队成员：设计师" }),
  ).toContainText("未分配步骤");
  fixture.complete();
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-collecting",
    "true",
    { timeout: 10000 },
  );
  await expect
    .poll(async () =>
      Number(
        await page
          .locator(".team-energy-canvas")
          .getAttribute("data-energy-time"),
      ),
    )
    .toBeGreaterThan(1.1);
  await page.screenshot({ path: ".local/team-orbit-20261109/collecting.png" });
  await page.getByRole("button", { name: "能量配色" }).click();
  await page.getByRole("menuitem", { name: "冰蓝能量" }).click();
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-tone",
    "ice",
  );
  await expect(
    page.getByRole("button", { name: "查看交付：已验收活动文案" }),
  ).toBeVisible({ timeout: 12000 });
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-collecting",
    "false",
  );
  await page.locator(".team-orbit-deliveries").evaluate(async (el) => {
    await Promise.all(
      el.getAnimations().map((animation) => animation.finished),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const slot = document
          .querySelector(".workspace-ai-companion-slot")!
          .getBoundingClientRect();
        const pet = document
          .querySelector('.workspace-companion[data-docked="true"]')
          ?.getBoundingClientRect();
        return pet
          ? Math.abs(pet.top - slot.top) + Math.abs(pet.left - slot.left)
          : 999;
      }),
    )
    .toBeLessThan(2);
  await page.screenshot({ path: ".local/team-orbit-20261109/delivered.png" });
  await page.getByRole("button", { name: "查看交付：已验收活动文案" }).click();
  await expect(
    page.getByRole("dialog", { name: "已验收活动文案" }),
  ).toContainText("第二版文案：按目标与素材形成的最终正文。");
  await page.locator(".ant-modal-close").click();
  await page.reload();
  await expect(page.locator(".workspace-ai-core-stage")).toHaveAttribute(
    "data-team-phase",
    "delivered",
  );
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-tone",
    "ice",
  );
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-collecting",
    "false",
  );
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await expect(page.locator(".workspace-team-layer")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "打开日程", exact: true }),
  ).toBeVisible();
  await openPersonalAssistant(page);
  await page.getByRole("button", { name: "在星轨中查看", exact: true }).click();
  await expect(page.locator(".workspace-ai-core-stage")).toHaveAttribute(
    "data-team-phase",
    "delivered",
  );
  await expect(page.getByRole("dialog", { name: /AI 个人助理/ })).toBeHidden();
  expect(fixture.submissions).toHaveLength(1);
});

test("手机星轨尊重减少动态效果，DeerFlow 不伪造成员与独立验收", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await setup(page, { deerflow: true });
  await submitInWorkspace(page);
  await expect(page.locator(".team-orbit-node")).toHaveCount(1);
  await expect(page.locator(".team-orbit-node")).toContainText("DeerFlow");
  fixture.complete();
  await expect(page.locator(".team-orbit-deliveries")).toContainText(
    "待独立验收",
    { timeout: 10000 },
  );
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-collecting",
    "false",
  );
  await page.screenshot({
    path: ".local/team-orbit-20261109/mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "查看交付：活动文案交付" }).click();
  await expect(
    page.getByRole("dialog", { name: "活动文案交付" }),
  ).toContainText("待验收");
});

test("星轨遇到执行失败不播放成功动效", async ({ page }) => {
  const fixture = await setup(page);
  await submitInWorkspace(page);
  fixture.interrupt("FAILED");
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-status",
    "FAILED",
    { timeout: 10000 },
  );
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-collecting",
    "false",
  );
  await expect(page.locator(".team-orbit-deliveries")).toHaveCount(0);
  await expect(
    page.getByText("执行服务暂时不可用", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.team-orbit-node[data-active="true"]'),
  ).toHaveCount(0);
});

async function openTeam(page: Page) {
  await page.goto("/my-workspace");
  await openPersonalAssistant(page);
  await selectAssistantPanel(page, "团队设置");
  await expect(
    page.getByRole("heading", { name: "智能体团队", exact: true }),
  ).toBeVisible();
  return page.getByRole("dialog", { name: /AI 个人助理/ });
}
async function selectOption(page: Page, label: string, name: string) {
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: label, exact: true })
    .click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText(name, { exact: true })
    .click();
}

test("团队设置可从 DeerFlow 切换 Mastra 并保存，选择期间不发送任务", async ({
  page,
}) => {
  const fixture = await setup(page, { deerflow: true });
  const panel = await openTeam(page);
  await expect(
    panel.getByRole("combobox", { name: "团队执行引擎" }),
  ).toBeVisible();
  await selectOption(page, "团队执行引擎", "Mastra");
  await expect(
    panel.getByRole("tab", { name: "团队成员", exact: true }),
  ).toBeVisible();
  expect(fixture.saves).toHaveLength(0);
  expect(fixture.submissions).toHaveLength(0);
  await panel
    .getByRole("button", { name: "保存团队配置", exact: true })
    .click();
  await expect.poll(() => fixture.saves[0]?.engine).toBe("mastra");
  await expect(
    panel.getByRole("button", { name: "保存团队配置", exact: true }),
  ).toBeDisabled();
  await selectOption(page, "团队执行引擎", "DeerFlow");
  await panel
    .getByRole("button", { name: "保存团队配置", exact: true })
    .click();
  await expect.poll(() => fixture.saves[1]?.engine).toBe("deerflow");
  await expect(
    panel.getByRole("tab", { name: "团队成员", exact: true }),
  ).toHaveCount(0);
});

test("聊天中选择团队并展示交付，切回普通模型继续追问且刷新保留任务卡片", async ({
  page,
}) => {
  const fixture = await setup(page, { deerflow: true });
  await page.goto("/my-workspace");
  await openPersonalAssistant(page);
  const panel = page.getByRole("dialog", { name: /AI 个人助理/ });
  await panel.getByRole("button", { name: "选择对话模型" }).click();
  await page.getByRole("menuitem", { name: /智能体团队/ }).click();
  await expect(
    panel.getByRole("button", { name: "选择对话模型" }),
  ).toContainText("智能体团队");
  await panel.locator("textarea").fill("根据刚才的讨论整理活动文案");
  await panel.getByRole("button", { name: "提交团队任务" }).click();
  const card = panel.getByRole("article", { name: "对话中的团队任务" });
  await expect(card).toContainText("团队正在处理资料");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  fixture.complete();
  await expect(card.getByRole("heading", { name: "任务结果" })).toBeVisible({
    timeout: 10000,
  });
  await expect(
    card.getByText("已整理活动文案，请核对交付内容。", { exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("article", { name: "交付：活动文案交付" }),
  ).toBeHidden();
  await card.locator("details > summary").click();
  await expect(
    card.getByRole("article", { name: "交付：活动文案交付" }),
  ).toBeVisible();
  await card.locator("details > summary").click();
  await panel.getByRole("button", { name: "选择对话模型" }).click();
  await page.getByRole("menuitem", { name: /通用助手/ }).click();
  await panel.locator("textarea").fill("把刚才的结果概括为两点");
  await panel.getByRole("button", { name: "发送给个人助理" }).click();
  await expect.poll(() => fixture.personal.length).toBe(1);
  expect(fixture.personal[0]).toMatchObject({
    model: "engine/fast",
    message: "把刚才的结果概括为两点",
  });
  await expect(card).toBeVisible();
  await page.reload();
  await openPersonalAssistant(page);
  await expect(card).toContainText("团队成果已返回");
  await page.screenshot({ path: ".local/unified-chat-team.png" });
});

test("团队可新增和编辑独立模型，保存才用于新任务，核心职责不能关闭", async ({
  page,
}) => {
  const fixture = await setup(page, { video: true });
  const panel = await openTeam(page);
  await expect(panel.locator(".team-member")).toHaveCount(7);
  await expect(
    panel.getByRole("switch", { name: "启用小序 · 主脑", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "新增智能体", exact: true }).click();
  await panel
    .getByRole("textbox", { name: "智能体名称", exact: true })
    .fill("品牌审校员");
  await panel
    .getByRole("textbox", { name: "智能体职责", exact: true })
    .fill("校对品牌名称和产品信息，明确提出需要修改的地方。");
  await selectOption(page, "智能体模型策略", "指定模型");
  await selectOption(page, "智能体指定模型", "推理模型 · qwen3-max");
  await selectOption(
    page,
    "智能体图像模型",
    "图像设计 · wan-image · 支持参考图",
  );
  await selectOption(page, "智能体视频模型", "视频生成 · wan-video · 720p");
  await panel
    .getByRole("switch", { name: "启用小序 · 研究员", exact: true })
    .click();
  expect(fixture.saves).toHaveLength(0);
  await panel
    .getByRole("button", { name: "保存团队配置", exact: true })
    .click();
  await expect(
    panel.getByText("配置已保存，仅用于新任务", { exact: false }),
  ).toBeVisible();
  expect(fixture.saves).toHaveLength(1);
  expect(fixture.saves[0].members.at(-1)).toMatchObject({
    name: "品牌审校员",
    role: "custom",
    modelMode: "fixed",
    modelId: "engine/strong",
    imageModelId: "image/design",
    videoModelId: "video/generate",
  });
  expect(
    fixture.saves[0].members.find((member) => member.id === "research")
      ?.enabled,
  ).toBe(false);
  await panel
    .getByRole("button", { name: "刷新智能体团队", exact: true })
    .click();
  await expect(
    panel.getByRole("article", { name: "智能体：品牌审校员" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/assistant-team-members.png",
    fullPage: true,
  });
});

test("团队任务提交附件与明确模型，按后台轮询验收版本并进入知识档案", async ({
  page,
}) => {
  const fixture = await setup(page);
  const panel = await openTeam(page);
  await panel.locator(".assistant-team-task-settings summary").click();
  await selectOption(page, "团队任务模型", "推理模型 · qwen3-max");
  await panel
    .getByRole("checkbox", { name: "使用知识档案", exact: true })
    .uncheck();
  await panel.getByRole("button", { name: "返回聊天并使用团队" }).click();
  await expect(page.locator("textarea:visible")).toHaveCount(1);
  await panel.getByLabel("上传助理附件").setInputFiles({
    name: "素材.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("活动素材与要求"),
  });
  await expect(panel.getByText("素材.txt", { exact: true })).toBeVisible();
  await panel
    .locator("textarea")
    .fill("根据素材创作完整活动文案，并由调度验收后归档");
  await panel
    .getByRole("button", { name: "提交团队任务", exact: true })
    .click();
  await expect(
    panel.getByText("编剧正在根据素材生成第一版", { exact: true }),
  ).toBeVisible();
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.submissions[0]).toMatchObject({
    goal: "根据素材创作完整活动文案，并由调度验收后归档",
    attachmentIds: [attachmentId],
    model: "engine/strong",
    useKnowledge: false,
  });
  expect(fixture.personal).toHaveLength(0);
  await panel.locator(".assistant-team-message > details > summary").click();
  await expect(
    panel.getByText("本步骤模型：qwen3-max", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("已验收归档", { exact: true })).toHaveCount(0);
  await panel.locator(".assistant-team-message > details > summary").click();
  fixture.complete();
  await expect(panel.getByText("验收与归档完成", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await panel.locator(".assistant-team-message > details > summary").click();
  await expect(panel.getByText("第 2 版", { exact: false })).toBeVisible();
  await expect(panel.getByText("已验收归档", { exact: true })).toBeVisible();
  await selectAssistantPanel(page, "团队设置");
  await panel.getByRole("tab", { name: "知识档案", exact: true }).click();
  await panel
    .getByRole("searchbox", { name: "搜索团队知识档案", exact: true })
    .fill("活动文案");
  await panel.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(
    panel.getByRole("article", { name: "交付：已验收活动文案" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "素材来源", exact: true }),
  ).toHaveAttribute("href", "https://example.com/source");
});

test("手机配置冲突与提交失败保留草稿，团队面板不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await setup(page, {
    rejectSubmission: true,
    saveConflict: true,
  });
  const panel = await openTeam(page);
  await panel.getByRole("button", { name: "新增智能体", exact: true }).click();
  await panel
    .getByRole("textbox", { name: "智能体名称", exact: true })
    .fill("待保存校对员");
  await panel
    .getByRole("button", { name: "保存团队配置", exact: true })
    .click();
  await expect(
    panel.getByText("团队配置已在其他窗口更新，请重新载入后保存", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel.getByRole("textbox", { name: "智能体名称", exact: true }),
  ).toHaveValue("待保存校对员");
  await panel.getByRole("button", { name: "返回聊天并使用团队" }).click();
  const input = panel.getByPlaceholder("描述团队目标、交付要求和验收标准…");
  await input.fill("创作一份新品上市方案");
  await panel
    .getByRole("button", { name: "提交团队任务", exact: true })
    .click();
  await expect(
    panel.getByText("团队执行服务暂时不可用，请稍后重试", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("创作一份新品上市方案");
  await expect(
    panel.getByText("团队执行服务暂时不可用，请稍后重试", { exact: true }),
  ).toBeInViewport();
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.personal).toHaveLength(0);
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/assistant-team-mobile.png",
    fullPage: true,
  });
});

test("默认团队策略可直接提交，停止任务读取后台取消状态并保留真实说明", async ({
  page,
}) => {
  const fixture = await setup(page);
  const panel = await openTeam(page);
  await panel.getByRole("button", { name: "返回聊天并使用团队" }).click();
  await panel
    .getByPlaceholder("描述团队目标、交付要求和验收标准…")
    .fill("整理一份新品宣传文案");
  await panel
    .getByRole("button", { name: "提交团队任务", exact: true })
    .click();
  await expect(
    panel.getByText("编剧正在根据素材生成第一版", { exact: true }),
  ).toBeVisible();
  expect(fixture.submissions[0]).toMatchObject({
    attachmentIds: [],
    useKnowledge: true,
  });
  expect(fixture.submissions[0].model).toBeUndefined();
  await panel
    .getByRole("button", { name: "停止团队任务", exact: true })
    .click();
  await expect(panel.getByText("任务已取消", { exact: true })).toBeVisible();
  await expect(
    page.getByText("已停止团队调度；已经提交的生成服务不保证远端停止。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "停止团队任务", exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByText("已验收归档", { exact: true })).toHaveCount(0);
});

test("DeerFlow 团队直接提交附件与目标，隐藏原生配置并将返回成果标为待验收", async ({
  page,
}) => {
  const fixture = await setup(page, { deerflow: true });
  const panel = await openTeam(page);
  await expect(
    panel.getByRole("tab", { name: "协作任务", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByRole("tab", { name: "团队成员", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "保存团队配置", exact: true }),
  ).toBeDisabled();
  await panel.locator(".assistant-team-task-settings summary").click();
  await expect(
    panel.getByRole("combobox", { name: "团队任务模型", exact: true }),
  ).toHaveCount(0);
  await panel
    .getByRole("checkbox", { name: "使用知识档案", exact: true })
    .uncheck();
  await panel.getByRole("button", { name: "返回聊天并使用团队" }).click();
  await panel.getByLabel("上传助理附件").setInputFiles({
    name: "素材.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("新品上市素材"),
  });
  await expect(panel.getByText("素材.txt", { exact: true })).toBeVisible();
  await panel
    .getByPlaceholder("描述团队目标、交付要求和验收标准…")
    .fill("根据附件整理新品上市活动文案");
  await panel
    .getByRole("button", { name: "提交团队任务", exact: true })
    .click();
  await expect(
    panel.getByText("团队正在处理资料", { exact: true }),
  ).toBeVisible();
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.submissions[0]).toMatchObject({
    goal: "根据附件整理新品上市活动文案",
    attachmentIds: [attachmentId],
    useKnowledge: false,
  });
  expect(fixture.submissions[0].model).toBeUndefined();
  expect(fixture.personal).toHaveLength(0);
  fixture.complete();
  await expect(panel.getByText("团队成果已返回", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect(
    panel.getByRole("heading", { name: "任务结果", exact: true }),
  ).toBeVisible();
  await panel.locator("summary").filter({ hasText: "执行详情" }).click();
  await expect(
    panel
      .getByRole("article", { name: "交付：活动文案交付", exact: true })
      .getByText("待验收", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("结果已返回，尚未经过本站独立验收。", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("已验收归档", { exact: true })).toHaveCount(0);
  await selectAssistantPanel(page, "团队设置");
  await panel.getByRole("tab", { name: "知识档案", exact: true }).click();
  await expect(
    panel.getByText("尚无匹配的知识档案", { exact: true }),
  ).toBeVisible();
  expect(fixture.saves).toHaveLength(0);
});

test("DeerFlow 未就绪时显示服务原因并阻止提交", async ({ page }) => {
  const fixture = await setup(page, { deerflow: true, ready: false });
  const panel = await openTeam(page);
  await expect(
    panel.getByText("团队服务连接尚未配置，请联系管理员。", { exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "返回聊天并使用团队" }).click();
  await expect(
    panel.getByPlaceholder("团队智能服务尚未就绪，请查看面板提示"),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "提交团队任务", exact: true }),
  ).toHaveCount(0);
  expect(fixture.submissions).toHaveLength(0);
});
