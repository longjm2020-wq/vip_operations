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
    canceled = false,
    refreshFailed = false;
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
    } else if (run && path === `${root}/runs/${run.id}`) {
      if (refreshFailed) {
        await route.fulfill({
          status: 503,
          json: { error: { message: "进度读取暂时失败" } },
        });
        return;
      }
      data = currentRun();
    } else if (run && path === `${root}/runs/${run.id}/cancel`) {
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
    phase: (status: "QUEUED" | "PLANNING" | "REVIEWING") => {
      if (run)
        run = {
          ...run,
          status,
          stage:
            status === "QUEUED"
              ? "等待团队开始"
              : status === "REVIEWING"
                ? "正在核对交付与验收标准"
                : "主脑正在制定执行计划",
          steps: run.steps.map((step) => ({
            ...step,
            status: status === "REVIEWING" ? "REVIEWING" : "PENDING",
          })),
        };
    },
    failRefresh: (failed: boolean) => {
      refreshFailed = failed;
    },
    executionStage: (
      stage: "writing" | "design",
      instruction?: string,
      completedResult?: string,
    ) => {
      if (!run) throw new Error("Submit a team task before updating its steps");
      const draft = run.steps.find((step) => step.id === "draft")!;
      run = {
        ...run,
        status: "RUNNING",
        stage:
          stage === "writing" ? "编剧正在整理活动文案" : "设计师正在制作主视觉",
        steps: [
          {
            ...draft,
            status: stage === "writing" ? "RUNNING" : "DONE",
            result:
              stage === "writing"
                ? "已核对针织材质，正在整理活动卖点。"
                : (completedResult ??
                  "活动文案已完成：以柔软针织为主题，突出通勤与叠穿场景。"),
          },
          {
            ...draft,
            id: "design",
            title: "制作上新主视觉",
            memberId: "design",
            instruction: instruction ?? "依据已完成文案制作针织上新主视觉",
            dependencies: ["draft"],
            deliverable: "image",
            status: stage === "writing" ? "PENDING" : "RUNNING",
            result:
              stage === "writing"
                ? undefined
                : "已读取文案，正在确认主视觉构图。",
          },
        ],
      };
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

async function memberMovement(page: Page) {
  return page.locator(".team-orbit-node").evaluateAll(async (nodes) => {
    const centers = () =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
    const before = centers();
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const sample = () => {
        if (performance.now() - start >= 350) resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    return Math.max(
      ...centers().map((point, index) =>
        Math.hypot(point.x - before[index].x, point.y - before[index].y),
      ),
    );
  });
}

test("星轨左侧执行详情跟随真实步骤，完成项可展开且中断不伪装执行", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const fixture = await setup(page);
  await submitInWorkspace(page);
  const rail = page.getByRole("complementary", { name: "团队执行详情" });
  const current = rail.locator(".team-execution-current-content");
  const detailScroll = rail.locator(".team-execution-scroll");
  const header = rail.locator(".team-execution-header");
  const progress = page.getByLabel("团队任务进度", { exact: true });
  const visibleOutput = current.locator(
    '.team-execution-output > span[aria-hidden="true"]',
  );
  fixture.executionStage("writing");
  await expect(
    current.getByRole("heading", { name: "创作活动文案" }),
  ).toBeVisible();
  await expect(current.locator(".team-execution-instruction")).toContainText(
    "结合所附资料完成活动文案",
  );
  await current.locator(".team-execution-instruction > summary").click();
  await expect(current.locator(".team-execution-instruction p")).toBeVisible();
  await current.locator(".team-execution-instruction > summary").click();
  await expect(visibleOutput).toHaveText("已核对针织材质，正在整理活动卖点。", {
    timeout: 10000,
  });
  await expect(rail).toHaveAttribute("data-active", "true");
  await expect(rail).toHaveAttribute("data-compact", "false");
  for (const { width, height } of [
    { width: 1920, height: 951 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
    { width: 960, height: 900 },
    { width: 800, height: 900 },
  ]) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(
        () =>
          rail.evaluate((panel) => {
            const stage = panel.closest(".workspace-ai-core-stage")!;
            const stageBounds = stage.getBoundingClientRect();
            const track = stage
              .querySelector(".team-orbit-track")!
              .getBoundingClientRect();
            const halos = [
              ...stage.querySelectorAll(
                ".team-orbit-node .workspace-dock-halo",
              ),
            ].map((halo) => halo.getBoundingClientRect());
            const halfWidth = Math.max(...halos.map((halo) => halo.width)) / 2;
            const halfHeight =
              Math.max(...halos.map((halo) => halo.height)) / 2;
            // The whole orbit envelope must fit, not just members' current angles.
            const envelope = {
              left: track.left - halfWidth,
              right: track.right + halfWidth,
              top: track.top - halfHeight,
              bottom: track.bottom + halfHeight,
            };
            const heading = stage
              .querySelector(".team-orbit-heading")!
              .getBoundingClientRect();
            const caption = stage
              .querySelector(".team-orbit-caption")!
              .getBoundingClientRect();
            const railBounds = panel.getBoundingClientRect();
            const toolbar = document
              .querySelector(".workspace-world-controls")!
              .getBoundingClientRect();
            const panelStyle = getComputedStyle(panel);
            const progress = document.querySelector<HTMLElement>(
              ".team-task-progress",
            )!;
            const progressBounds = progress.getBoundingClientRect();
            const date = document
              .querySelector(".workspace-date")!
              .getBoundingClientRect();
            const clearOf = (rect: DOMRect) =>
              rect.width === 0 ||
              rect.height === 0 ||
              progressBounds.right <= rect.left + 1 ||
              progressBounds.left >= rect.right - 1 ||
              progressBounds.bottom <= rect.top + 1 ||
              progressBounds.top >= rect.bottom - 1;
            const composer = document
              .querySelector(".personal-workspace .assistant-compose")!
              .getBoundingClientRect();
            const documentBounds = document.documentElement;
            return {
              pageFitsViewport:
                documentBounds.scrollWidth <= window.innerWidth + 1 &&
                documentBounds.scrollHeight <= window.innerHeight + 1 &&
                Math.abs(window.scrollY) < 1,
              composerInsideViewport:
                composer.top >= 0 &&
                composer.bottom <= window.innerHeight &&
                composer.left >= 0 &&
                composer.right <= window.innerWidth,
              widerDesktopPanel:
                window.innerWidth < 1440 || railBounds.width >= 320,
              alignedDesktopColumn:
                panel.getAttribute("data-compact") === "true" ||
                (Math.abs(railBounds.left - toolbar.left) <= 1 &&
                  Math.abs(railBounds.width - toolbar.width) <= 1),
              transparentPanel:
                panelStyle.backgroundColor === "rgba(0, 0, 0, 0)" &&
                panelStyle.backgroundImage === "none" &&
                panelStyle.boxShadow === "none",
              progressFitsHeader:
                progressBounds.left >= 0 &&
                progressBounds.right <= window.innerWidth &&
                progressBounds.bottom <= stageBounds.top + 1 &&
                progress.scrollWidth <= progress.clientWidth + 1 &&
                clearOf(toolbar) &&
                clearOf(date),
              noOuterRailScrollbar:
                getComputedStyle(panel).overflowY === "hidden",
              insideStageAndViewport:
                envelope.left >= Math.max(0, stageBounds.left) &&
                envelope.right <=
                  Math.min(window.innerWidth, stageBounds.right) &&
                envelope.top >= Math.max(0, stageBounds.top) &&
                envelope.bottom <=
                  Math.min(window.innerHeight, stageBounds.bottom),
              belowHeading: envelope.top >= heading.bottom,
              aboveCaption: envelope.bottom <= caption.top,
              clearOfExecutionPanel:
                panel.getAttribute("data-compact") === "true"
                  ? envelope.bottom <= railBounds.top
                  : envelope.left >= railBounds.right,
            };
          }),
        {
          message: `${width}x${height} viewport contains the composer and full member orbit without page scrolling`,
        },
      )
      .toEqual({
        pageFitsViewport: true,
        composerInsideViewport: true,
        widerDesktopPanel: true,
        alignedDesktopColumn: true,
        transparentPanel: true,
        progressFitsHeader: true,
        noOuterRailScrollbar: true,
        insideStageAndViewport: true,
        belowHeading: true,
        aboveCaption: true,
        clearOfExecutionPanel: true,
      });
    if ([1920, 1366, 960, 800].includes(width))
      await page.screenshot({
        path: `.local/minimal-execution-20261110/execution-${width}x${height}.png`,
      });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(rail).toHaveAttribute("data-compact", "false");

  fixture.executionStage("design");
  await expect(
    current.getByRole("heading", { name: "制作上新主视觉" }),
  ).toBeVisible({ timeout: 10000 });
  await expect(current.locator(".team-execution-member")).toHaveText("设计师");
  await expect(current.locator(".team-execution-instruction")).toContainText(
    "依据已完成文案制作针织上新主视觉",
  );
  await expect(visibleOutput).toHaveText("已读取文案，正在确认主视觉构图。");
  const completed = rail.locator(".team-execution-history");
  await expect(completed.locator(":scope > summary")).toContainText(
    /已完成\s*1\s*步/,
  );
  await completed.locator(":scope > summary").click();
  const finishedStep = completed.locator(".team-execution-history-step");
  await finishedStep.locator("summary").click();
  await expect(finishedStep).toContainText(
    "活动文案已完成：以柔软针织为主题，突出通勤与叠穿场景。",
  );
  await expect(current).not.toContainText("活动文案已完成：");
  await page.screenshot({
    path: ".local/minimal-execution-20261110/history-desktop.png",
    fullPage: true,
  });

  await completed.locator(":scope > summary").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rail).toHaveAttribute("data-compact", "true");
  await expect
    .poll(() =>
      rail.evaluate((panel) => {
        const bounds = panel.getBoundingClientRect();
        return (
          bounds.left >= 0 &&
          bounds.right <= window.innerWidth &&
          document.documentElement.scrollWidth <= window.innerWidth
        );
      }),
    )
    .toBe(true);
  await current
    .getByRole("heading", { name: "制作上新主视觉" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: ".local/minimal-execution-20261110/execution-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1600, height: 1000 });

  // Long server-provided detail remains accessible inside its own panel.
  const longInstruction =
    "请逐项核对素材、版式与交付规格，记录每一项结果。".repeat(60);
  const longCompletedResult =
    "已完成文案校对，所有卖点与素材一致，已记录验收结果。".repeat(60);
  fixture.executionStage("design", longInstruction, longCompletedResult);
  await expect(current.locator(".team-execution-instruction")).toContainText(
    longInstruction,
    { timeout: 10000 },
  );
  await current.locator(".team-execution-instruction > summary").click();
  await expect
    .poll(() =>
      detailScroll.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return {
          internallyScrollable:
            el.clientHeight > 0 &&
            el.scrollHeight > el.clientHeight &&
            el.scrollTop > 0 &&
            Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1,
          pageStillFits:
            document.documentElement.scrollHeight <= window.innerHeight + 1 &&
            Math.abs(window.scrollY) < 1,
        };
      }),
    )
    .toEqual({ internallyScrollable: true, pageStillFits: true });

  await completed.locator(":scope > summary").click();
  if ((await finishedStep.getAttribute("open")) === null)
    await finishedStep.locator("summary").click();
  await expect(finishedStep).toContainText(longCompletedResult);
  for (const viewport of [
    { width: 1920, height: 951 },
    { width: 1366, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        rail.evaluate((panel) => {
          const scroll = panel.querySelector<HTMLElement>(
            ".team-execution-scroll",
          )!;
          scroll.scrollTop = scroll.scrollHeight;
          const historyReachesBottom =
            scroll.clientHeight > 0 &&
            scroll.scrollHeight > scroll.clientHeight &&
            scroll.scrollTop > 0 &&
            Math.abs(
              scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
            ) <= 1;
          const verticalScrollAreas = [
            ...panel.querySelectorAll<HTMLElement>("*"),
          ].filter(
            (el) =>
              ["auto", "scroll"].includes(getComputedStyle(el).overflowY) &&
              el.scrollHeight > el.clientHeight + 1,
          );
          const heading = panel.querySelector<HTMLElement>(
            ".team-execution-current-content h4",
          )!;
          heading.scrollIntoView({ block: "nearest" });
          const railBounds = panel.getBoundingClientRect();
          const scrollBounds = scroll.getBoundingClientRect();
          const headingBounds = heading.getBoundingClientRect();
          const headerBounds = panel
            .querySelector(".team-execution-header")!
            .getBoundingClientRect();
          return {
            historyReachesBottom,
            singleVerticalScrollArea:
              verticalScrollAreas.length === 1 &&
              verticalScrollAreas[0] === scroll,
            currentContentAccessible:
              headingBounds.top >= scrollBounds.top - 1 &&
              headingBounds.bottom <= scrollBounds.bottom + 1 &&
              scrollBounds.top >= headerBounds.bottom &&
              scrollBounds.bottom <= railBounds.bottom + 1,
            noOuterRailScroll:
              getComputedStyle(panel).overflowY === "hidden" &&
              panel.scrollHeight <= panel.clientHeight + 1,
          };
        }),
      )
      .toEqual({
        historyReachesBottom: true,
        singleVerticalScrollArea: true,
        currentContentAccessible: true,
        noOuterRailScroll: true,
      });
    const scrollBounds = (await detailScroll.boundingBox())!;
    await detailScroll.hover({
      position: {
        x: scrollBounds.width - 3,
        y: Math.min(80, scrollBounds.height / 2),
      },
      force: true,
    });
    await page.screenshot({
      path: `.local/minimal-execution-20261110/history-expanded-${viewport.width}x${viewport.height}.png`,
    });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });

  fixture.failRefresh(true);
  await expect(progress).toHaveAttribute("data-health", "stale", {
    timeout: 10000,
  });
  await expect(progress.locator('[data-step="delivery"]')).not.toHaveAttribute(
    "data-state",
    "complete",
  );
  await expect(rail).toHaveAttribute("data-active", "false");
  await expect(header).toContainText("进度暂未更新");
  fixture.failRefresh(false);
  await rail.getByRole("button", { name: "重试", exact: true }).click();
  await expect(progress).toHaveAttribute("data-health", "normal");
  await expect(rail).toHaveAttribute("data-active", "true");

  // Retain the last server step snapshot while the overall run is interrupted.
  fixture.interrupt("NEEDS_USER");
  await expect(header.locator(".team-execution-status")).toHaveText(
    "等待你补充",
    { timeout: 10000 },
  );
  await expect(rail).toHaveAttribute("data-active", "false");
  await expect(progress).toHaveAttribute("data-health", "attention");
  await expect(progress).toContainText("等待补充资料");
  await expect(progress.locator('[data-step="delivery"]')).not.toHaveAttribute(
    "data-state",
    "complete",
  );
  await expect(header.locator(".anticon-spin")).toHaveCount(0);
  fixture.interrupt("FAILED");
  // Terminal runs stop polling; reopening reloads the latest saved task state.
  await page.reload();
  await expect(header.locator(".team-execution-status")).toHaveText(
    "执行中断",
    { timeout: 10000 },
  );
  await expect(rail).toHaveAttribute("data-active", "false");
  await expect(progress).toHaveAttribute("data-health", "error");
  await expect(progress).toContainText("执行中断");
  await expect(progress.locator('[data-step="delivery"]')).not.toHaveAttribute(
    "data-state",
    "complete",
  );
  await expect(current.locator(".team-execution-problem")).toHaveText(
    "执行服务暂时不可用",
  );
  await completed.locator(":scope > summary").click();
  await finishedStep.locator("summary").click();
  await expect(finishedStep).toBeVisible();

  expect(fixture.submissions).toHaveLength(1);
});

test("星轨成员公转保持文字正向，悬停继续旋转且键盘和详情可操作", async ({
  page,
}) => {
  await setup(page);
  await submitInWorkspace(page);
  const member = page.getByRole("button", { name: "查看团队成员：编剧" });
  await expect.poll(() => memberMovement(page)).toBeGreaterThan(2);
  await member.hover({ force: true });
  await expect.poll(() => memberMovement(page)).toBeGreaterThan(2);
  expect(
    await member.evaluate((node) =>
      [
        node,
        ...node.querySelectorAll(".team-orbit-disc, strong, small, .anticon"),
      ].every((element) => {
        const transform = getComputedStyle(element).transform;
        if (transform === "none") return true;
        const matrix = new DOMMatrix(transform);
        return (
          matrix.a > 0 &&
          matrix.d > 0 &&
          Math.abs(matrix.b) < 0.001 &&
          Math.abs(matrix.c) < 0.001
        );
      }),
    ),
  ).toBe(true);

  // Switch to keyboard input before focusing, so :focus-visible pauses motion.
  await page.keyboard.press("Tab");
  await member.focus();
  await expect(member).toBeFocused();
  await expect.poll(() => memberMovement(page)).toBeLessThan(1);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "编剧", exact: true }),
  ).toBeVisible();
  await expect.poll(() => memberMovement(page)).toBeLessThan(1);
  await page.locator(".ant-modal-close").click();
  await member.evaluate((node) => node.blur());
  await page.mouse.move(0, 0);
  await expect.poll(() => memberMovement(page)).toBeGreaterThan(2);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => memberMovement(page)).toBeLessThan(1);
});

test("星轨展示真实协作、仅在新交付时汇聚、保留配色并可打开成果", async ({
  page,
}) => {
  test.setTimeout(90000);
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
  const desktopViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.locator(".team-orbit-node").evaluateAll((nodes) =>
        nodes.every((node) => {
          const bounds = node.getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= window.innerWidth;
        }),
      ),
    )
    .toBe(true);
  await expect.poll(() => memberMovement(page)).toBeLessThan(1);
  await page.screenshot({
    path: ".local/team-orbit-20261109/mobile-members.png",
    fullPage: true,
  });
  await page.setViewportSize(desktopViewport);
  const teamScene = page.locator(".workspace-team-layer");
  const progress = page.getByLabel("团队任务进度", { exact: true });
  await expect(progress.locator('[data-step="execution"]')).toHaveAttribute(
    "data-state",
    "current",
  );
  await expect(progress.locator('[data-step="delivery"]')).toHaveAttribute(
    "data-state",
    "waiting",
  );
  const energyCanvas = page.locator(".team-energy-canvas");
  await expect(teamScene).toHaveAttribute("data-energized", "true");
  await expect
    .poll(async () => Number(await energyCanvas.getAttribute("data-ring-time")))
    .toBeGreaterThan(0);
  await page.screenshot({
    path: ".local/team-orbit-20261109/orbital-running.png",
  });
  fixture.phase("QUEUED");
  await expect(teamScene).toHaveAttribute("data-status", "QUEUED", {
    timeout: 10000,
  });
  await expect(teamScene).toHaveAttribute("data-energized", "false");
  await expect(progress.locator('[data-state="complete"]')).toHaveCount(0);
  fixture.phase("PLANNING");
  await expect(teamScene).toHaveAttribute("data-status", "PLANNING", {
    timeout: 10000,
  });
  await expect(teamScene).toHaveAttribute("data-energized", "true");
  await expect(progress.locator('[data-step="planning"]')).toHaveAttribute(
    "data-state",
    "current",
  );
  await expect(
    page.locator('.team-orbit-node[data-active="true"]'),
  ).toHaveCount(0);
  const planningTime = Number(
    await energyCanvas.getAttribute("data-ring-time"),
  );
  await expect
    .poll(async () => Number(await energyCanvas.getAttribute("data-ring-time")))
    .toBeGreaterThan(planningTime + 0.15);
  fixture.executionStage("writing");
  await expect(teamScene).toHaveAttribute("data-status", "RUNNING", {
    timeout: 10000,
  });
  await expect(progress.locator('[data-step="execution"]')).toHaveAttribute(
    "data-state",
    "current",
  );
  fixture.phase("REVIEWING");
  await expect(teamScene).toHaveAttribute("data-status", "REVIEWING", {
    timeout: 10000,
  });
  await expect(progress.locator('[data-step="review"]')).toHaveAttribute(
    "data-state",
    "current",
  );
  await expect(progress.locator('[data-step="delivery"]')).toHaveAttribute(
    "data-state",
    "waiting",
  );
  fixture.complete();
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-collecting",
    "true",
    { timeout: 10000 },
  );
  await expect(teamScene).toHaveAttribute("data-energized", "false");
  await expect(progress.locator('[data-state="complete"]')).toHaveCount(4);
  await expect.poll(() => memberMovement(page)).toBeLessThan(1);
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
  for (const [label, tone, energyColor] of [
    ["紫色能量", "purple", "#9c88ff"],
    ["金色能量", "gold", "#ffd277"],
    ["蓝色能量", "blue", "#73baff"],
  ]) {
    await page.getByRole("button", { name: "能量配色" }).click();
    await expect(page.getByRole("menuitem", { name: /粉|玫瑰/ })).toHaveCount(
      0,
    );
    await page.getByRole("menuitem", { name: label }).click();
    await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
      "data-tone",
      tone,
    );
    await expect
      .poll(() =>
        teamScene.evaluate((el) =>
          getComputedStyle(el).getPropertyValue("--team-energy").trim(),
        ),
      )
      .toBe(energyColor);
  }
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
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 960, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const bounds = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect();
          const composer = bounds(".personal-workspace .assistant-compose");
          const delivery = bounds(".team-orbit-deliveries");
          const card = bounds(".team-orbit-file");
          const rail = bounds(".team-execution-rail");
          const nest = bounds(".workspace-world-plane > .workspace-ai-core");
          const insideViewport = (rect: DOMRect) =>
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= innerWidth &&
            rect.bottom <= innerHeight;
          return {
            pageFits:
              document.documentElement.scrollHeight <= innerHeight + 1 &&
              document.documentElement.scrollWidth <= innerWidth + 1,
            composerVisible: insideViewport(composer),
            deliveryVisible:
              insideViewport(delivery) &&
              insideViewport(card) &&
              card.bottom <= delivery.bottom + 1,
            deliveryRightOfNest: delivery.left >= nest.right - 1,
            deliveryAboveComposer: delivery.bottom <= composer.top,
            deliveryClearOfRail:
              delivery.bottom <= rail.top ||
              delivery.top >= rail.bottom ||
              delivery.right <= rail.left ||
              delivery.left >= rail.right,
          };
        }),
      )
      .toEqual({
        pageFits: true,
        composerVisible: true,
        deliveryVisible: true,
        deliveryRightOfNest: true,
        deliveryAboveComposer: true,
        deliveryClearOfRail: true,
      });
    await page.screenshot({
      path: `.local/team-viewport-20261109/delivered-${viewport.width}x${viewport.height}.png`,
    });
  }
  await page.setViewportSize(desktopViewport);
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
    "blue",
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
  await expect(page.locator(".workspace-companion")).toHaveAttribute(
    "data-docked",
    "true",
  );
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
  expect(
    await page.locator(".team-energy-canvas").getAttribute("data-ring-time"),
  ).toBeNull();
  fixture.complete();
  await expect(page.locator(".team-orbit-deliveries")).toContainText(
    "待独立验收",
    { timeout: 10000 },
  );
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-collecting",
    "false",
  );
  const progress = page.getByLabel("团队任务进度", { exact: true });
  await expect(progress.locator('[data-step="review"]')).toHaveAttribute(
    "data-state",
    "unverified",
  );
  await expect(progress.locator('[data-step="delivery"]')).toHaveAttribute(
    "data-state",
    "complete",
  );
  await expect(progress.locator('[data-state="complete"]')).not.toHaveCount(4);
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
  await expect(page.locator(".workspace-team-layer")).toHaveAttribute(
    "data-energized",
    "false",
  );
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
