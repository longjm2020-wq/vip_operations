import { expect, test, type Page } from "@playwright/test";
import type { AssistantMessage } from "../../packages/contracts/src/personal-assistant.js";
import {
  emptyDirectorLocks,
  type DirectorProject,
  type DirectorRender,
  type DirectorShot,
} from "../../packages/contracts/src/director.js";

const id = "2badc035-074b-4e18-991f-df97a2814fb1";
const fileId = "db5722f2-1062-4d1c-93b8-1802b77715d2";
const assetId = "395a030e-c8c3-4652-9ca4-57395b0b0e96";
const shotId = "bdc3ad39-35fc-45b9-abae-6e1275aed146";
const renderId = "e4645bd8-7b48-47e2-a274-b894660173d8";
const deviceId = "0d340a6d-ef45-467a-8e77-6953315e05dc";
const jobId = "0fba78cb-e74a-4b5b-a0c1-04abb7095cae";
const referenceId = "4a25771d-7967-4e8d-9cc9-6b45b21c2940";
const timestamp = "2026-11-27T08:00:00.000Z";
const path = "/my-workspace/director";
const projectPath = "/my-workspace/director/projects";
const initialShot: DirectorShot = {
  id: shotId,
  title: "展示纹理",
  script: "展示面料的自然垂坠。",
  caption: "自然垂坠",
  visualId: assetId,
  startMs: 0,
  audioStartMs: 0,
  durationMs: 3500,
  effect: "fade",
  locks: { ...emptyDirectorLocks },
};
const initialAsset = {
  id: assetId,
  fileId,
  source: "library",
  role: "product",
  name: "春款.jpg",
  mime: "image/jpeg",
} as const;

async function mockDirector(
  page: Page,
  initial: Partial<DirectorProject> = {},
  native = false,
  options?: { storyboardGate?: Promise<void>; assistantReady?: boolean },
) {
  const assistant = await mockDirectorAssistant(page, options?.assistantReady);
  let project: DirectorProject = {
    id,
    title: "春款商品视频",
    mode: "manual",
    output: "script",
    aspect: "9:16",
    brief: "",
    durationMs: 12000,
    revision: 1,
    assets: [],
    shots: [],
    renders: [],
    referenceAnalysis: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...initial,
  };
  const calls: { method: string; action: string; body: any }[] = [];
  const nativeActions: { action: string; payload: any }[] = [];
  let nativeState = "idle";
  if (native) {
    await page.exposeFunction(
      "directorTestRequest",
      (request: { action: string; payload: any }) => {
        const { action, payload } = request;
        if (action.startsWith("director-"))
          nativeActions.push({ action, payload });
        if (action === "status")
          return {
            version: "9.0.0",
            connected: true,
            authorized: true,
            deviceId,
          };
        if (action === "director-capabilities")
          return { ffmpeg: true, installation: "" };
        if (action === "director-import")
          return {
            assets: [
              { id: fileId, name: "春款.jpg", kind: "image", bytes: 30 },
            ],
          };
        if (action === "director-open") return { opened: true };
        if (action === "director-start") nativeState = "running";
        if (action === "director-pause") nativeState = "paused";
        if (action === "director-resume") nativeState = "completed";
        return {
          jobId,
          state: nativeState,
          progress: nativeState === "completed" ? 100 : 30,
          stage: nativeState === "completed" ? "交付已生成" : "正在处理镜头",
          totalShots: 1,
          completedShots: Number(nativeState === "completed"),
          reusedShots: 0,
        };
      },
    );
    await page.addInitScript(() => {
      const eventTarget = new EventTarget();
      const configured = window as typeof window & {
        directorTestRequest(request: { id: string }): Promise<unknown>;
      };
      Object.defineProperty(window, "xutiDesktop", {
        value: { version: "9.0.0", director: true },
      });
      Object.defineProperty(window.chrome, "webview", {
        value: {
          addEventListener: eventTarget.addEventListener.bind(eventTarget),
          removeEventListener:
            eventTarget.removeEventListener.bind(eventTarget),
          postMessage: (request: { id: string }) => {
            void configured.directorTestRequest(request).then((data) =>
              eventTarget.dispatchEvent(
                new MessageEvent("message", {
                  data: {
                    channel: "xuti-desktop",
                    id: request.id,
                    ok: true,
                    data,
                  },
                }),
              ),
            );
          },
        },
      });
    });
  }
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      json: {
        data: {
          id: "1",
          username: "director",
          displayName: "导演台测试",
          roleCodes: [],
          permissions: ["analytics.read", "analytics.manage"],
          csrfToken: "fixture",
        },
      },
    }),
  );
  await page.route("**/api/v1/my-workspace/assistant/files", async (route) => {
    if (route.request().method() !== "POST")
      return route.fulfill({ json: { data: [] } });
    const payload = route.request().postDataBuffer()?.toString("utf8") || "";
    const isReference = payload.includes("参考短片.mp4");
    return route.fulfill({
      json: {
        data: {
          id: isReference ? referenceId : fileId,
          name: isReference ? "参考短片.mp4" : "春款.jpg",
          mime: isReference ? "video/mp4" : "image/jpeg",
          size: 32,
          source: "upload",
          createdAt: timestamp,
        },
      },
    });
  });
  await page.route(`**/api/v1${projectPath}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const action = url.pathname.slice(`/api/v1${projectPath}`.length);
    const body = request.postData() ? request.postDataJSON() : undefined;
    calls.push({ method, action, body });
    let data: unknown;
    if (!action && method === "GET") data = { items: [project] };
    else if (!action && method === "POST") {
      const { requestId: _requestId, ...fields } = body;
      project = { ...project, ...fields, revision: 1 };
      data = project;
    } else if (action === `/${id}` && method === "PATCH") {
      expect(body.revision).toBe(project.revision);
      project = { ...project, ...body, revision: project.revision + 1 };
      data = project;
    } else if (action.endsWith("/reference")) {
      expect(body.revision).toBe(project.revision);
      const analysis = {
        assetId: body.assetId,
        summary: "先展示轮廓，再切细节。",
        beats: [{ timeMs: 0, description: "开场给全景" }],
        model: "fixture/model",
      };
      project = {
        ...project,
        revision: project.revision + 1,
        referenceAnalyses: [...(project.referenceAnalyses || []), analysis],
        referenceAnalysis: analysis,
      };
      data = project;
    } else if (action.endsWith("/storyboard")) {
      expect(body.revision).toBe(project.revision);
      const visual =
        project.assets.find((item) => item.fileId === fileId) || initialAsset;
      const planned = {
        ...project,
        revision: project.revision + 1,
        shots: [{ ...initialShot, visualId: visual.id }],
        assets: [
          visual,
          ...project.assets.filter((item) => item.id !== visual.id),
        ],
      };
      await options?.storyboardGate;
      if (body.revision === project.revision) project = planned;
      data = planned;
    } else if (action.endsWith("/suggestions")) {
      data = {
        revision: project.revision,
        shotId: body.shotId,
        suggestions: [
          { ...project.shots[0], script: "可以先试试这件。", caption: "试穿" },
          {
            ...project.shots[0],
            script: "先看细节，再看整体。",
            caption: "看看细节",
          },
        ],
      };
    } else if (action.endsWith("/script")) {
      expect(url.searchParams.get("revision")).toBe(String(project.revision));
      data = {
        title: project.title,
        markdown: project.shots.map((shot) => shot.script).join("\n"),
      };
    } else if (action.endsWith("/renders")) {
      const render: DirectorRender = {
        id: renderId,
        projectId: id,
        version: 7,
        revision: project.revision,
        deviceId,
        status: "queued",
        progress: 0,
        stage: "等待本机启动",
        outputs: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      project = { ...project, renders: [render] };
      data = render;
    } else if (action.endsWith(renderId) && method === "PATCH") {
      const render = { ...project.renders[0], ...body };
      project = { ...project, renders: [render] };
      data = render;
    } else data = project;
    await route.fulfill({ json: { data } });
  });
  return { calls, nativeActions, assistant, project: () => project };
}

async function mockDirectorAssistant(page: Page, ready = true) {
  const sends: Record<string, unknown>[] = [];
  const messages: AssistantMessage[] = [];
  const desktop = {
    devices: [
      {
        id: deviceId,
        name: "已连接的剪辑电脑",
        platform: "windows",
        online: true,
        engineReady: true,
        crossWindowAuthorized: true,
        lastSeenAt: timestamp,
        pairedAt: timestamp,
      },
    ],
    tasks: [],
  };
  const responses: Record<string, unknown> = {
    "/my-workspace": {
      version: 1,
      note: "",
      todos: [],
      schedule: [],
      shortcuts: [],
      available: [],
      defaults: { name: "我的工作台", description: "", tools: [] },
    },
    "/my-workspace/appearance": { mode: "dark", version: 1 },
    "/my-workspace/activity": { items: [], serverTime: timestamp },
    "/my-workspace/assistant/capabilities": {
      defaultModel: "fixture/model",
      models: ready
        ? [{ id: "fixture/model", name: "测试模型", vision: true }]
        : [],
      imageModels: [],
    },
    "/my-workspace/assistant/desktop": desktop,
    "/my-workspace/assistant/browser": { ready: true, tasks: [] },
    "/my-workspace/assistant/voice": { ready: false, enabled: false },
    "/my-workspace/assistant/realtime": { ready: false, enabled: false },
  };
  await page.context().route("**/api/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname.slice("/api/v1".length);
    if (pathname === "/my-workspace/assistant") {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        sends.push(body);
        messages.push(
          {
            id: body.requestId,
            role: "user",
            text: body.message,
            createdAt: timestamp,
          },
          {
            id: `answer-${body.requestId}`,
            role: "assistant",
            text: "交办已收到。",
            createdAt: timestamp,
          },
        );
      }
      await route.fulfill({
        json: {
          data: {
            ready,
            state: "IDLE",
            version: sends.length,
            error: "",
            messages,
          },
        },
      });
      return;
    }
    if (pathname.endsWith("/content")) {
      await route.fulfill({
        path: "tests/fixtures/selection-care-label.png",
        contentType: "image/png",
      });
      return;
    }
    await route.fulfill({ json: { data: responses[pathname] ?? [] } });
  });
  return sends;
}

async function openDirectorChat(page: Page) {
  await page.goto("/my-workspace");
  const composer = page.locator(".assistant-compose:visible");
  await expect(composer.locator("textarea")).toBeEditable();
  return composer;
}

test("导演台可从空白手工创作、采用候选文案、锁定并只导出脚本", async ({
  page,
}) => {
  const fixture = await mockDirector(page);
  await page.goto(path);
  await expect(page.getByRole("link", { name: "AI 导演台" })).toBeVisible();
  await page.goto(`${path}?project=${id}`);
  await expect(page.getByRole("heading", { name: "AI 导演台" })).toBeVisible();
  await page.getByRole("button", { name: "新增空白分镜" }).click();
  await page.getByLabel("镜头名称").fill("开场取近景");
  await page.getByLabel("口播与分镜脚本").fill("这是我的初稿。");
  await page.getByRole("button", { name: "提供两种本镜文案" }).click();
  await expect(page.getByLabel("口播与分镜脚本")).toHaveValue("这是我的初稿。");
  await page.getByRole("button", { name: "采用方案 2" }).click();
  await expect(page.getByLabel("口播与分镜脚本")).toHaveValue(
    "先看细节，再看整体。",
  );
  await page.getByRole("checkbox", { name: "锁文案" }).check();
  await expect(page.getByLabel("口播与分镜脚本")).toBeDisabled();
  await expect(page.getByLabel("画面素材")).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出分镜脚本" }).click();
  expect((await download).suggestedFilename()).toContain("分镜脚本.md");
  expect(fixture.project().shots[0]).toMatchObject({
    title: "开场取近景",
    script: "先看细节，再看整体。",
    locks: { script: true, asset: false },
  });
  expect(
    fixture.calls.some(
      (call) =>
        call.action.endsWith("/storyboard") || call.action.endsWith("/renders"),
    ),
  ).toBe(false);
});

test("浏览器打开聊天的智能交办会编排一次并提示 Windows 剪辑", async ({
  page,
}) => {
  const fixture = await mockDirector(page, {
    mode: "smart",
    output: "video",
    brief: "编排春款试穿视频",
    assets: [
      {
        id: referenceId,
        fileId: referenceId,
        name: "参考短片.mp4",
        mime: "video/mp4",
        source: "library",
        role: "reference",
      },
    ],
  });
  await page.goto(`${path}?project=${id}&run=1`);
  await expect(page.getByRole("button", { name: "AI 编排分镜" })).toBeEnabled();
  expect(fixture.calls.some((call) => call.method === "POST")).toBe(false);
  await page.evaluate(
    (projectId) =>
      history.replaceState(
        {
          ...history.state,
          usr: { directorAutostart: projectId },
        },
        "",
      ),
    id,
  );
  await page.reload();
  await expect(
    page.getByText(
      "分镜已编排。请在具备剪辑能力的 Windows 桌面端打开此项目，继续生成成片。",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "后台剪辑", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "导出分镜脚本", exact: true }),
  ).toBeEnabled();
  await expect(page).toHaveURL(`${path}?project=${id}`);
  await page.reload();
  await expect(page.getByRole("button", { name: /展示纹理/ })).toBeVisible();
  expect(
    fixture.calls.filter((call) => call.action.endsWith("/storyboard")),
  ).toHaveLength(1);
  expect(
    fixture.calls
      .filter((call) => call.method === "POST")
      .map((call) => call.action.split("/").at(-1)),
  ).toEqual(["reference", "storyboard"]);
  expect(fixture.calls.some((call) => call.action.endsWith("/renders"))).toBe(
    false,
  );
});

test("多附件进入素材库，并可单独修正自动识别的角色", async ({ page }) => {
  const fixture = await mockDirector(page);
  await page.goto(`${path}?project=${id}`);
  await page.getByLabel("上传项目文件", { exact: true }).setInputFiles([
    { name: "春款.jpg", mimeType: "image/jpeg", buffer: Buffer.from("sample") },
    {
      name: "参考短片.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("sample"),
    },
  ]);
  await expect(
    page.getByRole("button", { name: /春款.jpg.*商品素材/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /参考短片.mp4.*参考片/ }).click();
  await page.getByLabel("素材角色", { exact: true }).click();
  await page
    .locator(".ant-select-dropdown")
    .getByText("商品素材", { exact: true })
    .click();
  await page.getByRole("button", { name: /保存项目/ }).click();
  await expect
    .poll(() => fixture.project().assets.map((item) => [item.name, item.role]))
    .toEqual([
      ["春款.jpg", "product"],
      ["参考短片.mp4", "product"],
    ]);
});

test("人工确认后使用冻结版本启动本机，暂停再继续并打开四份产物", async ({
  page,
}) => {
  const fixture = await mockDirector(
    page,
    { output: "video", shots: [initialShot], assets: [initialAsset] },
    true,
  );
  await page.goto(`${path}?project=${id}`);
  await expect(
    page.getByRole("button", { name: "确认分镜并后台剪辑" }),
  ).toBeEnabled();
  expect(
    fixture.nativeActions.some((call) => call.action === "director-start"),
  ).toBe(false);
  await page.getByRole("button", { name: "确认分镜并后台剪辑" }).click();
  await expect(page.getByText("后台剪辑中")).toBeVisible();
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.getByText("已导出", { exact: true })).toBeVisible();
  for (const name of ["视频成片（MP4）", "分镜脚本", "字幕（SRT）", "剪辑方案"])
    await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "视频成片（MP4）" }).click();
  await expect
    .poll(() =>
      fixture.nativeActions.some(
        (call) =>
          call.action === "director-open" && call.payload.artifact === "video",
      ),
    )
    .toBe(true);
  expect(
    fixture.nativeActions.find((call) => call.action === "director-start")
      ?.payload,
  ).toMatchObject({
    projectId: id,
    version: 7,
    plan: {
      aspect: "9:16",
      shots: [
        { id: shotId, visualId: fileId, effect: "fade", caption: "自然垂坠" },
      ],
    },
  });
  expect(
    fixture.calls.find((call) => call.action.endsWith("/renders"))?.body,
  ).toMatchObject({ revision: 1, deviceId, confirm: true });
});

test("小序提交简短创作指令及两份附件，带正确角色进入智能成片", async ({
  page,
}) => {
  const fixture = await mockDirector(page, {}, true);
  const composer = await openDirectorChat(page);
  await composer.getByLabel("上传助理附件").setInputFiles([
    {
      name: "春款.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("fixture"),
    },
    {
      name: "参考短片.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("fixture"),
    },
  ]);
  await expect(composer.locator(".agent-attachments")).toContainText(
    "春款.jpg",
  );
  await expect(composer.locator(".agent-attachments")).toContainText(
    "参考短片.mp4",
  );
  const brief = "做一条短视频";
  await composer.locator("textarea").fill(brief);
  await expect(
    composer.getByRole("button", { name: "本条目标：AI 导演台" }),
  ).toBeVisible();
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect(page).toHaveURL(`${path}?project=${id}`);
  await expect(
    page.getByRole("heading", { name: "AI 导演台", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("智能导演", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      fixture.nativeActions.some((call) => call.action === "director-start"),
    )
    .toBe(true);
  const creation = fixture.calls.find(
    (call) => call.method === "POST" && !call.action,
  );
  expect(creation?.body).toMatchObject({
    brief,
    mode: "smart",
    output: "video",
    assets: [
      { id: fileId, fileId, role: "product", source: "library" },
      {
        id: referenceId,
        fileId: referenceId,
        role: "reference",
        source: "library",
      },
    ],
  });
  expect(
    fixture.calls
      .filter((call) => call.method === "POST")
      .map((call) => call.action.split("/").at(-1)),
  ).toEqual(["", "reference", "storyboard", "renders"]);
  expect(fixture.assistant).toEqual([]);
  await expect(page.getByRole("dialog", { name: /AI 个人助理/ })).toHaveCount(
    0,
  );
});

test("普通对话模型不可用时仍可打开导演台和创建人工项目，等待确认", async ({
  page,
}) => {
  const fixture = await mockDirector(page, {}, true, { assistantReady: false });
  const composer = await openDirectorChat(page);
  await composer.locator("textarea").fill("打开 AI 导演台");
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect(page).toHaveURL(path);
  expect(fixture.calls.every((call) => call.method === "GET")).toBe(true);
  await page.goto("/my-workspace");
  const brief = "人工做一条商品视频";
  await composer.locator("textarea").fill(brief);
  await composer.getByRole("button", { name: "发送给个人助理" }).click();
  await expect(page).toHaveURL(`${path}?project=${id}`);
  await expect(
    page.getByRole("button", { name: "新增空白分镜" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认分镜并后台剪辑" }),
  ).toBeDisabled();
  expect(
    fixture.calls
      .filter((call) => call.method === "POST")
      .map((call) => ({ action: call.action, mode: call.body.mode })),
  ).toEqual([{ action: "", mode: "manual" }]);
  expect(
    fixture.nativeActions.some((call) => call.action === "director-start"),
  ).toBe(false);
  expect(fixture.assistant).toEqual([]);
});

test("明确选择桌面或云端目标时，视频措辞仍交给原目标", async ({ page }) => {
  const fixture = await mockDirector(page);
  const { assistant } = fixture;
  const composer = await openDirectorChat(page);
  const text = composer.locator("textarea");
  const instruction = "制作一条商品视频";
  const submit = () =>
    composer.getByRole("button", { name: "发送给个人助理" }).click();
  await text.fill(instruction);
  await composer.getByRole("button", { name: "本条目标：AI 导演台" }).click();
  await page
    .getByRole("menuitem", { name: "操作我的电脑", exact: true })
    .click();
  await page.getByRole("button", { name: "设为常用电脑", exact: true }).click();
  await expect(
    composer.getByRole("button", { name: /本条目标：操作我的电脑/ }),
  ).toBeVisible();
  await submit();
  await expect.poll(() => assistant.length).toBe(1);
  expect(assistant[0]).toMatchObject({
    message: instruction,
    desktopDeviceId: deviceId,
  });
  await expect(text).toHaveValue(instruction);
  await composer.getByRole("button", { name: /本条目标：/ }).click();
  await page
    .getByRole("menuitem", { name: "操作云端网页", exact: true })
    .click();
  await expect(
    composer.getByRole("button", { name: /本条目标：操作网页 · 云端/ }),
  ).toBeVisible();
  await submit();
  await expect.poll(() => assistant.length).toBe(2);
  expect(assistant[1]).toMatchObject({
    message: instruction,
    browserExecution: true,
  });
  expect(assistant[1]).not.toHaveProperty("desktopDeviceId");
  expect(fixture.calls.every((call) => call.method === "GET")).toBe(true);
  await expect(page).toHaveURL("/my-workspace");
});

test("导演台只有一个侧栏入口，窄屏收起导航时分镜完整可操作", async ({
  page,
}, testInfo) => {
  await mockDirector(page, {
    output: "video",
    shots: [initialShot],
    assets: [initialAsset],
  });
  await page.goto(`${path}?project=${id}`);
  const nav = page.getByRole("menu", { name: "工作区导航" });
  const entry = nav.getByRole("link", { name: "AI 导演台", exact: true });
  const pageTitle = page.getByRole("heading", {
    name: "AI 导演台",
    exact: true,
  });
  await expect(entry).toHaveCount(1);
  await expect(pageTitle).toBeVisible();
  await expect(
    page.getByRole("button", { name: "打开小序文字对话" }),
  ).toBeVisible();
  await expect(page.locator(".workspace-companion")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("director-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  const expand = page.getByRole("button", { name: "展开工作区导航" });
  await expect(expand).toBeVisible();
  await expect(entry).toBeHidden();
  await expect(pageTitle).toBeInViewport();
  await expand.click();
  await expect(entry).toHaveCount(1);
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(entry).toBeHidden();
  const noOverflow = await page
    .locator(".director-page")
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        bounds.left >= 0 &&
        bounds.right <= document.documentElement.clientWidth + 1 &&
        element.scrollWidth <= element.clientWidth + 1
      );
    });
  expect(noOverflow).toBe(true);
  await page.getByRole("button", { name: "新增空白分镜" }).click();
  await page.getByLabel("镜头名称").fill("窄屏新增镜头");
  await expect(
    page.getByRole("button", { name: /窄屏新增镜头/ }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("director-mobile.png"),
    fullPage: true,
  });
});

test("人工接管先暂停同机活动渲染并保存人工模式", async ({ page }) => {
  const fixture = await mockDirector(
    page,
    {
      mode: "smart",
      output: "video",
      shots: [initialShot],
      assets: [initialAsset],
    },
    true,
  );
  await page.goto(`${path}?project=${id}`);
  await page.getByRole("button", { name: "后台剪辑", exact: true }).click();
  await expect(page.getByText("后台剪辑中")).toBeVisible();
  await page.getByRole("button", { name: "人工接管", exact: true }).click();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
  await expect(
    page.getByText("已切换到人工确定。下一次剪辑需由你确认。"),
  ).toBeVisible();
  expect(fixture.project().mode).toBe("manual");
  expect(
    fixture.nativeActions.some(
      (call) => call.action === "director-pause" && call.payload.version === 7,
    ),
  ).toBe(true);
  const writes = fixture.calls.filter((call) => call.method === "PATCH");
  expect(
    writes.findIndex((call) => call.body.status === "paused"),
  ).toBeLessThan(writes.findIndex((call) => call.body.mode === "manual"));
  await page.reload();
  await expect(
    page.getByRole("button", { name: "确认分镜并后台剪辑" }),
  ).toBeEnabled();
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
});

test("编排中的人工接管保留手工编辑，迟到 AI 结果无法启动剪辑", async ({
  page,
}) => {
  let release!: () => void;
  const storyboardGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await mockDirector(
    page,
    { mode: "smart", output: "video", assets: [initialAsset] },
    true,
    { storyboardGate },
  );
  await page.goto(`${path}?project=${id}`);
  await page.getByRole("button", { name: "智能编排并剪辑" }).click();
  await expect
    .poll(() =>
      fixture.calls.some((call) => call.action.endsWith("/storyboard")),
    )
    .toBe(true);
  await page.getByRole("button", { name: "人工接管", exact: true }).click();
  await expect(
    page.getByText("已切换到人工确定。下一次剪辑需由你确认。"),
  ).toBeVisible();
  const storyboard = page.waitForResponse((response) =>
    response.url().endsWith("/storyboard"),
  );
  release();
  await storyboard;
  await page.getByRole("button", { name: "新增空白分镜" }).click();
  await page.getByLabel("镜头名称").fill("接管后由我编排");
  await expect(
    page.getByRole("button", { name: /接管后由我编排/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /展示纹理/ })).toHaveCount(0);
  expect(fixture.calls.some((call) => call.action.endsWith("/renders"))).toBe(
    false,
  );
  expect(
    fixture.nativeActions.some((call) => call.action === "director-start"),
  ).toBe(false);
});
