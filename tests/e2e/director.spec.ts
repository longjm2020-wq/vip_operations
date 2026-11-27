import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
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

type DirectorStage = "整理素材" | "编排分镜" | "交付导出";

function stageButton(page: Page, name: DirectorStage) {
  return page
    .getByRole("navigation", { name: "导演台制作流程" })
    .getByRole("button", { name, exact: true });
}

async function openStage(page: Page, name: DirectorStage) {
  const button = stageButton(page, name);
  await button.click();
  await expect(button).toHaveAttribute("aria-current", "step");
}

async function mockDirector(
  page: Page,
  initial: Partial<DirectorProject> = {},
  native = false,
  options?: {
    storyboardGate?: Promise<void>;
    assistantReady?: boolean;
    pickedAssets?: { id: string; name: string; kind: string; bytes: number; durationMs?: number; folderRole?: string }[];
    linkedImport?: boolean;
    folderRoleImport?: boolean;
    pickSummary?: { skippedFolders: number; skippedFiles: number; problems: string[]; duplicates: number; overLimit: boolean };
    previewFrame?: string;
  },
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
  const uploadedFiles: string[] = [];
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
          return { ffmpeg: true, installation: "", localReferenceImport: options?.linkedImport, folderRoleImport: options?.folderRoleImport };
        if (action === "director-read-frame")
          return { mime: "image/jpeg", base64: options?.previewFrame || "" };
        if (action === "director-pick") {
          if (!options?.linkedImport) {
            expect(Object.keys(payload).sort()).toEqual(["kind", "projectId"]);
            return { assets: options?.pickedAssets || [] };
          }
          return {
            assets: options.pickedAssets || [], ...options.pickSummary,
          };
        }
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
    const request = route.request();
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), {
      headers: { "content-type": request.headers()["content-type"] },
    }).formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw Error("上传请求缺少文件");
    uploadedFiles.push(file.name);
    return route.fulfill({
      json: {
        data: {
          id: file.name === "参考短片.mp4" ? referenceId : file.name === "春款.jpg" ? fileId : randomUUID(),
          name: file.name,
          mime: file.type,
          size: file.size,
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
    } else if (action.endsWith("/reference-link")) {
      data = { id: referenceId, name: "春款作品.mp4", mime: "video/mp4", size: 1024, source: "upload", createdAt: timestamp };
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
  return { calls, nativeActions, uploadedFiles, assistant, project: () => project };
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
  await page.getByRole("button", { name: /春款商品视频/ }).click();
  await expect(page).toHaveURL(`${path}?project=${id}`);
  await expect(page.getByRole("heading", { name: "AI 导演台" })).toBeVisible();
  await expect(stageButton(page, "整理素材")).toHaveAttribute("aria-current", "step");
  await openStage(page, "编排分镜");
  await page.getByRole("button", { name: "新增空白分镜" }).click();
  await page.getByLabel("镜头名称").fill("开场取近景");
  await page.getByLabel("口播与分镜脚本").fill("这是我的初稿。");
  await expect(page.getByRole("button", { name: "提供两种本镜文案" })).toBeHidden();
  await page.locator("summary").filter({ hasText: "更多镜头设置" }).click();
  await page.getByRole("button", { name: "提供两种本镜文案" }).click();
  await expect(page.getByLabel("口播与分镜脚本")).toHaveValue("这是我的初稿。");
  await page.getByRole("button", { name: "采用方案 2" }).click();
  await expect(page.getByLabel("口播与分镜脚本")).toHaveValue(
    "先看细节，再看整体。",
  );
  await page.getByRole("checkbox", { name: "锁文案" }).check();
  await expect(page.getByLabel("口播与分镜脚本")).toBeDisabled();
  await expect(page.getByLabel("画面素材")).toBeEnabled();
  await openStage(page, "交付导出");
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

test("文件夹导入几十 GiB 的本机素材后列出跳过项并可分页保存", async ({ page }) => {
  const localId = randomUUID();
  const assets = Array.from({ length: 499 }, (_, index) => ({
    id: randomUUID(), name: index === 497 ? "节奏参考片.mp4" : `素材-${index + 1}.mp4`, kind: "video" as const,
    bytes: index === 0 ? 36 * 1024 ** 3 : 1024, durationMs: 1500,
  }));
  const fixture = await mockDirector(page, {
    assets: [{ id: assetId, source: "local", role: "product", localId, deviceId, name: "已有.jpg", mime: "image/jpeg" }],
  }, true, {
    linkedImport: true, pickedAssets: assets,
    pickSummary: { skippedFolders: 1, skippedFiles: 2, problems: ["说明.txt：不支持此格式"], duplicates: 1, overLimit: true },
  });
  await page.goto(`${path}?project=${id}`);
  await page.getByRole("button", { name: "导入本机文件夹" }).click();
  const notice = page.getByText(/已加入 499 份本机素材（36 GiB）/);
  await expect(notice).toContainText("已跳过 2 个文件");
  await expect(notice).toContainText("说明.txt");
  await expect(notice).toContainText("余下文件可在另一项目继续导入");
  expect(fixture.nativeActions.find((a) => a.action === "director-pick")?.payload).toEqual({
    projectId: id, kind: "folder", remaining: 499, knownIds: [localId],
  });
  await expect(page.getByText("500 / 500")).toBeVisible();
  const media = page.getByRole("region", { name: "素材库" });
  await media.getByTitle("13", { exact: true }).click();
  await expect(media.getByRole("button", { name: /素材-499.mp4/ })).toBeVisible();
  const filters = media.getByRole("group", { name: "按用途筛选" });
  await filters.getByRole("button", { name: /参考片\s*1$/ }).click();
  await expect(media.getByRole("button", { name: /节奏参考片\.mp4/, pressed: true })).toBeVisible();
  await expect(media.getByTitle("13", { exact: true })).toHaveCount(0);
  await filters.getByRole("button", { name: /商品素材\s*499$/ }).click();
  await expect(media.getByRole("button", { name: /已有\.jpg/, pressed: true })).toBeVisible();
  await media.getByTitle("13", { exact: true }).click();
  await expect(media.getByRole("button", { name: /素材-480\.mp4/, pressed: true })).toBeVisible();
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect.poll(() => fixture.project().assets.length).toBe(500);
  expect(fixture.project().assets.at(-1)?.localId).toBe(assets.at(-1)?.id);
});

test("旧 Windows 导演台继续使用原来的选文件桥接", async ({ page }) => {
  const fixture = await mockDirector(page, {}, true, {
    pickedAssets: [{ id: randomUUID(), name: "旧素材.mp4", kind: "video", bytes: 1024 ** 2, durationMs: 1000 }],
  });
  await page.goto(`${path}?project=${id}`);
  const more = page.getByRole("button", { name: /更多导入/ });
  await more.click();
  await page.getByRole("menuitem", { name: "从工作台文件选择" }).click();
  const dialog = page.getByRole("dialog", { name: "从工作台文件选择" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
  await more.click();
  const folderChooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "按模板上传文件夹" }).click();
  const folderInput = (await folderChooser).element();
  expect(await folderInput.getAttribute("webkitdirectory")).not.toBeNull();
  await more.click();
  const choosing = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "上传到工作台" }).click();
  const chooser = await choosing;
  expect(await chooser.element().getAttribute("aria-label")).toBe("上传项目文件");
  await chooser.setFiles([]);
  await page.getByRole("button", { name: "导入本机文件", exact: true }).click();
  await expect(page.getByText(/已加入 1 份本机素材/)).toBeVisible();
  expect(fixture.nativeActions.find((a) => a.action === "director-pick")?.payload).toEqual({ projectId: id, kind: "files" });
});

const roleImportSamples = [
  { label: "商品素材", role: "product", name: "品牌参考片.mp4", mimeType: "video/mp4" },
  { label: "授权肖像", role: "portrait", name: "A001.jpg", mimeType: "image/jpeg" },
  { label: "授权音色", role: "voiceSample", name: "正式旁白.wav", mimeType: "audio/wav" },
  { label: "正式配音", role: "narration", name: "音色样本.mp3", mimeType: "audio/mpeg" },
  { label: "参考片", role: "reference", name: "B001.mp4", mimeType: "video/mp4" },
  { label: "文字资料", role: "document", name: "说明.txt", mimeType: "text/plain" },
] as const;

test("网页从六个用途入口导入，略过不匹配的文件并保存人工指定用途", async ({ page }) => {
  const fixture = await mockDirector(page);
  await page.goto(`${path}?project=${id}`);
  const library = page.getByRole("region", { name: "素材库" });
  for (const sample of roleImportSamples) {
    const picker = page.waitForEvent("filechooser");
    await library.getByRole("button", { name: `导入${sample.label}`, exact: true }).click();
    const files: { name: string; mimeType: string; buffer: Buffer }[] = [
      { name: sample.name, mimeType: sample.mimeType, buffer: Buffer.from("fixture") },
    ];
    if (sample.role === "portrait") {
      files.push({ name: "错误的肖像.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("fixture") });
    }
    await (await picker).setFiles(files);
    await expect(library.getByRole("button", { name: new RegExp(sample.name) })).toContainText(sample.label);
  }
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect.poll(() => fixture.project().assets.map(({ name, role }) => ({ name, role })))
    .toEqual(roleImportSamples.map(({ name, role }) => ({ name, role })));
  expect(fixture.uploadedFiles).not.toContain("错误的肖像.mp3");
  await page.reload();
  for (const { name, role } of roleImportSamples.filter((item) => ["portrait", "voiceSample"].includes(item.role))) {
    const restored = library.getByRole("button", { name: new RegExp(name) });
    await expect(restored).toContainText("待确认授权");
    expect(fixture.project().assets.find((item) => item.role === role)?.authorized).toBeFalsy();
  }
});

test("下载六目录模板，选择真实目录时按目录用途导入嵌套文件", async ({ page }, testInfo) => {
  const fixture = await mockDirector(page);
  await page.goto(`${path}?project=${id}`);
  await page.getByRole("button", { name: "文件夹模板", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "素材文件夹模板" });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("六类文件夹模板.png"), animations: "disabled" });
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载模板" }).click();
  const template = await download;
  expect(template.suggestedFilename()).toMatch(/\.zip$/i);
  const zip = await JSZip.loadAsync(await readFile((await template.path())!));
  const folders = Object.values(zip.files).filter((entry) => entry.dir);
  const root = testInfo.outputPath("春季素材包");
  async function addFile(relativePath: string) {
    const file = join(root, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "fixture");
  }
  for (const { label, name } of roleImportSamples) {
    const directory = folders.find((entry) => entry.name.split("/").at(-2) === label);
    expect(directory, `模板目录 ${label}`).toBeDefined();
    await addFile(join(directory!.name, "第一批", name));
  }
  await addFile("授权肖像/错误音频.mp3");
  await addFile("其他/同行参考片.mp4");
  await page.keyboard.press("Escape");
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传文件夹", exact: true }).click();
  await (await picker).setFiles(root);
  await expect(page.getByText("7 / 500", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("按模板导入后的素材.png"), animations: "disabled" });
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect.poll(() => fixture.project().assets.length).toBe(7);
  const assets = fixture.project().assets;
  for (const { role, name } of roleImportSamples) {
    expect(assets.find((asset) => asset.name === name)?.role, name).toBe(role);
  }
  expect(assets.find((asset) => asset.name === "同行参考片.mp4")?.role).toBe("reference");
  expect(assets.some((asset) => asset.authorized)).toBe(false);
  expect(fixture.uploadedFiles).not.toContain("错误音频.mp3");
});

test("桌面分类导入与本机模板导入保留角色，文字资料走工作台", async ({ page }) => {
  const localFile = (name: string, kind: string, folderRole?: string) =>
    ({ id: randomUUID(), name, kind, bytes: 512, folderRole });
  const picked = [localFile("A001.jpg", "image"), localFile("不兼容.mp3", "audio")];
  const fixture = await mockDirector(page, {}, true, {
    linkedImport: true, folderRoleImport: true, pickedAssets: picked,
  });
  await page.goto(`${path}?project=${id}`);
  const library = page.getByRole("region", { name: "素材库" });
  await library.getByRole("button", { name: "导入授权肖像", exact: true }).click();
  await expect(library.getByRole("button", { name: /A001\.jpg/ })).toContainText("待确认授权");
  picked.splice(0, picked.length,
    localFile("正式旁白.wav", "audio", "voiceSample"),
    localFile("商品视频.mp4", "video", "reference"),
    localFile("商品照片.jpg", "image", "reference"),
  );
  await library.getByRole("button", { name: "导入本机文件夹", exact: true }).click();
  await expect(library.getByRole("button", { name: /正式旁白\.wav/ })).toContainText("待确认授权");
  const chooser = page.waitForEvent("filechooser");
  await library.getByRole("button", { name: "导入文字资料", exact: true }).click();
  await (await chooser).setFiles({ name: "台本.txt", mimeType: "text/plain", buffer: Buffer.from("镜头一") });
  await expect(library.getByRole("button", { name: /台本\.txt/ })).toContainText("文字资料");
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect.poll(() => fixture.project().assets.map(({ name, role, source }) => [name, role, source])).toEqual([
    ["A001.jpg", "portrait", "local"], ["正式旁白.wav", "voiceSample", "local"],
    ["商品视频.mp4", "reference", "local"], ["台本.txt", "document", "library"],
  ]);
  expect(fixture.uploadedFiles).toEqual(["台本.txt"]);
  expect(fixture.nativeActions.filter((item) => item.action === "director-pick").map((item) => item.payload.kind))
    .toEqual(["files", "folder"]);
});

test("作品分享链接取不到视频时可更正，重试后先保存参考片再拆解", async ({ page }) => {
  const fixture = await mockDirector(page);
  const failMessage = "该作品未返回可用视频，请更换链接。";
  await page.route("**/reference-link", (route) =>
    route.fulfill({ status: 422, json: { error: { message: failMessage } } }), { times: 1 });
  await page.goto(`${path}?project=${id}`);
  await page.getByRole("button", { name: "粘贴作品链接" }).click();
  const dialog = page.getByRole("dialog", { name: "从作品链接拆解参考片" });
  const input = dialog.getByRole("textbox", { name: "作品分享链接或分享文案" });
  const analyze = dialog.getByRole("button", { name: "解析并拆解" });
  await input.fill("https://video.example.com/unavailable");
  await analyze.click();
  await expect(dialog.getByText(failMessage)).toBeVisible();
  await expect(input).toBeEditable();
  expect(fixture.project().assets).toHaveLength(0);
  expect(fixture.calls.some((entry) => entry.action.endsWith("/reference"))).toBe(false);
  const link = "https://video.example.com/view/123";
  await input.fill(`春季面料短片\n复制浏览这条作品：${link}`);
  await analyze.click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => fixture.project().referenceAnalysis?.summary).toBe("先展示轮廓，再切细节。");
  const changed = fixture.calls.filter((entry) => entry.method !== "GET");
  expect(changed.map((entry) => entry.action)).toEqual([`/${id}/reference-link`, `/${id}`, `/${id}/reference`]);
  expect(JSON.stringify(changed[0].body)).toContain(link);
  const reference = fixture.project().assets[0];
  expect(reference).toMatchObject({ fileId: referenceId, role: "reference", name: "春款作品.mp4" });
  expect(fixture.project().referenceAnalysis?.assetId).toBe(reference.id);
  await page.reload();
  await expect(page.getByRole("region", { name: "素材库" }).getByRole("button", { name: /春款作品\.mp4/ })).toContainText("参考片");
});

test("作品已入库时即使拆解服务暂不可用也可从项目重试", async ({ page }) => {
  const fixture = await mockDirector(page);
  await page.route("**/reference", (route) =>
    route.fulfill({ status: 503, json: { error: { message: "拆解服务暂不可用" } } }), { times: 1 });
  await page.goto(`${path}?project=${id}`);
  await page.getByRole("button", { name: "粘贴作品链接" }).click();
  const dialog = page.getByRole("dialog", { name: "从作品链接拆解参考片" });
  await dialog.getByRole("textbox", { name: "作品分享链接或分享文案" }).fill("https://video.example.com/view/123");
  await dialog.getByRole("button", { name: "解析并拆解" }).click();
  await expect(page.getByText(/拆解服务暂不可用/).first()).toBeVisible();
  await page.reload();
  const library = page.getByRole("region", { name: "素材库" });
  await library.getByRole("button", { name: /春款作品\.mp4/ }).click();
  await page.getByRole("button", { name: "拆解参考片", exact: true }).click();
  await expect.poll(() => fixture.project().referenceAnalysis?.assetId).toBe(fixture.project().assets[0].id);
  expect(fixture.project().assets).toHaveLength(1);
  expect(fixture.calls.filter((entry) => entry.action.endsWith("/reference-link"))).toHaveLength(1);
});

test("新手从本机导入视频、查看本地画面并用它创建第一个分镜", async ({ page }, testInfo) => {
  const localId = randomUUID();
  const name = "20251118_WG7769.MP4";
  const previewFrame = (await sharp("tests/fixtures/selection-care-label.png")
    .resize({ width: 320 })
    .jpeg()
    .toBuffer()).toString("base64");
  const fixture = await mockDirector(page, { title: "羊绒衫面料展示" }, true, {
    pickedAssets: [{ id: localId, name, kind: "video", bytes: 1200000, durationMs: 8000 }],
    linkedImport: true,
    previewFrame,
  });
  const sentFrames: string[] = [];
  page.on("request", (request) => {
    if (request.postData()?.includes(previewFrame)) sentFrames.push(request.url());
  });
  await page.goto(`${path}?project=${id}`);
  await expect(stageButton(page, "整理素材")).toHaveAttribute("aria-current", "step");
  const importFile = page.getByRole("button", { name: "导入本机文件", exact: true });
  await expect(importFile).toBeInViewport();
  await expect(page.getByLabel("口播与分镜脚本")).toBeHidden();
  await expect(page.getByRole("button", { name: "导出分镜脚本" })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("director-getting-started.png") });
  await importFile.click();
  const selected = page.getByRole("region", { name: "素材库" }).getByRole("button", { name: /WG7769\.MP4/ });
  await expect(selected).toContainText("视频");
  await expect(selected).toContainText("商品素材");
  await expect.poll(() => fixture.nativeActions.find((action) => action.action === "director-read-frame")?.payload)
    .toMatchObject({ projectId: id, assetId: localId });
  const frame = page.locator('img[src^="data:image/jpeg;base64,"]:visible').first();
  await expect(frame).toBeInViewport();
  await expect.poll(() => frame.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
  await page.screenshot({ path: testInfo.outputPath("director-media-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const stage of ["整理素材", "编排分镜", "交付导出"] as const) {
    await expect(stageButton(page, stage)).toBeInViewport();
  }
  expect(await page.locator(".director-page").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("director-media-mobile.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "用此素材创建分镜", exact: true }).click();
  await expect(stageButton(page, "编排分镜")).toHaveAttribute("aria-current", "step");
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect.poll(() => fixture.project().shots.length).toBe(1);
  expect(fixture.project().shots[0].visualId).toBe(fixture.project().assets[0].id);
  await openStage(page, "交付导出");
  await expect(page.getByRole("button", { name: "导出分镜脚本" })).toBeEnabled();
  expect(sentFrames).toEqual([]);
  expect(fixture.calls.some((call) => /\/(storyboard|renders)$/.test(call.action))).toBe(false);
});

test("混合素材分别标明六种用途，筛选与改类同步显示授权", async ({
  page,
}, testInfo) => {
  const materials = [
    { name: "羊绒衫细节.jpg", kind: "image", role: "商品素材" },
    { name: "模特肖像.jpg", kind: "image", role: "授权肖像" },
    { name: "演员音色样本.wav", kind: "audio", role: "授权音色" },
    { name: "冬季旁白.mp3", kind: "audio", role: "正式配音" },
    { name: "节奏参考片.mp4", kind: "video", role: "参考片" },
  ];
  const fixture = await mockDirector(
    page,
    {
      title: "冬季羊绒衫拍摄素材",
      assets: [
        {
          id: assetId,
          fileId,
          source: "library",
          role: "document",
          name: "商品说明.txt",
          mime: "text/plain",
        },
      ],
    },
    true,
    {
      linkedImport: true,
      pickedAssets: materials.map(({ name, kind }) => ({
        id: randomUUID(),
        name,
        kind,
        bytes: 1024,
      })),
      previewFrame: (
        await sharp("tests/fixtures/selection-care-label.png")
          .resize(320)
          .jpeg()
          .toBuffer()
      ).toString("base64"),
    },
  );
  await page.goto(`${path}?project=${id}`);
  const library = page.getByRole("region", { name: "素材库" });
  const filters = library.getByRole("group", { name: "按用途筛选" });
  const filter = (role: string, count: number) =>
    filters.getByRole("button", { name: new RegExp(`^${role}\\s*${count}$`) });
  const assetRow = (name: string) =>
    library.getByRole("button", {
      name: new RegExp(name.replaceAll(".", "\\.")),
    });
  const consent = library.getByRole("checkbox");
  await filter("文字资料", 1).click();
  await page.getByRole("button", { name: "导入本机文件夹" }).click();
  await expect(filter("全部", 6)).toHaveAttribute("aria-pressed", "true");
  await expect(assetRow("羊绒衫细节.jpg")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const samples = [...materials, { name: "商品说明.txt", role: "文字资料" }];
  for (const { name, role } of samples) {
    await expect(filter(role, 1)).toBeVisible();
    await expect(assetRow(name)).toContainText(role);
  }
  await expect(assetRow("模特肖像.jpg")).toContainText("待确认授权");
  await expect(assetRow("演员音色样本.wav")).toContainText("待确认授权");
  await expect(assetRow("冬季旁白.mp3")).not.toContainText("待确认授权");
  await expect(
    page.getByRole("img", { name: "羊绒衫细节.jpg的预览画面" }),
  ).toBeInViewport();
  await expect(assetRow("节奏参考片.mp4")).toBeInViewport();
  await expect(page.getByRole("button", { name: "用此素材创建分镜", exact: true })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("素材用途-桌面.png"),
    animations: "disabled",
  });
  for (const width of [1280, 1360]) {
    await page.setViewportSize({ width, height: 900 });
    const row = assetRow("模特肖像.jpg");
    const authorization = await row.getByText("待确认授权", { exact: true }).boundingBox();
    const source = await row.getByText("图片 · 本机", { exact: true }).boundingBox();
    expect(authorization!.x + authorization!.width).toBeLessThanOrEqual(source!.x);
  }
  await page.screenshot({ path: testInfo.outputPath("素材用途-中等宽度.png"), animations: "disabled" });
  for (const width of [768, 820]) {
    await page.setViewportSize({ width, height: 900 });
    const director = page.locator(".director-page");
    await expect(page.getByRole("button", { name: "保存项目" })).toBeInViewport();
    const layout = await director.evaluate((element) => {
      const controls = [".director-projects", ".director-project-actions", ".director-steps"].map(
        (selector) => element.querySelector(selector)!.getBoundingClientRect(),
      );
      const overlap = controls.some((rect, index) =>
        controls.slice(index + 1).some((other) =>
          rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top,
        ),
      );
      return { overlap, overflow: element.scrollWidth > element.clientWidth + 1 };
    });
    expect(layout).toEqual({ overlap: false, overflow: false });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await library.evaluate(
      (section) => section.scrollWidth <= section.clientWidth + 1,
    ),
  ).toBe(true);
  await library.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("素材用途-手机.png"),
    fullPage: true,
    animations: "disabled",
  });

  await filter("授权音色", 1).click();
  await expect(assetRow("演员音色样本.wav")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(assetRow("冬季旁白.mp3")).toHaveCount(0);
  await expect(consent).not.toBeChecked();
  await consent.check();
  await expect(assetRow("演员音色样本.wav")).toContainText("已确认授权");
  await filter("正式配音", 1).click();
  await library.getByLabel("素材角色", { exact: true }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("授权音色", { exact: true })
    .click();
  await expect(filter("授权音色", 2)).toHaveAttribute("aria-pressed", "true");
  await expect(assetRow("冬季旁白.mp3")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(assetRow("冬季旁白.mp3")).toContainText("待确认授权");
  await expect(assetRow("演员音色样本.wav")).toContainText("已确认授权");
  await expect(consent).not.toBeChecked();
  await filter("正式配音", 0).click();
  await expect(library.getByText(/暂无正式配音/)).toBeVisible();
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect
    .poll(
      () =>
        fixture.project().assets.find((item) => item.name === "冬季旁白.mp3")
          ?.role,
    )
    .toBe("voiceSample");
  const assets = fixture.project().assets;
  expect(
    assets.find((item) => item.name === "演员音色样本.wav")?.authorized,
  ).toBe(true);
  expect(
    assets.find((item) => item.name === "冬季旁白.mp3")?.authorized,
  ).toBeFalsy();
  expect(
    assets.find((item) => item.name === "模特肖像.jpg")?.authorized,
  ).toBeFalsy();
});

test("外机视频仍显示媒体类型并保留其已有用途，只有改选角色后才用作商品画面", async ({ page }) => {
  const fixture = await mockDirector(page, {
    assets: [{
      id: assetId, localId: fileId, deviceId: randomUUID(), source: "local",
      name: "WG7769.MP4", role: "document", mime: "video/mp4", durationMs: 8000,
    }],
  }, true);
  await page.goto(`${path}?project=${id}`);
  const media = page.getByRole("region", { name: "素材库" });
  const video = media.getByRole("button", { name: /WG7769\.MP4/ });
  await expect(video).toContainText("视频");
  await expect(video).toContainText("文字资料");
  const useAsset = page.getByRole("button", { name: "用此素材创建分镜", exact: true });
  await expect(useAsset).toBeHidden();
  expect(fixture.project().assets[0].role).toBe("document");
  await page.getByRole("button", { name: "用作商品画面", exact: true }).click();
  await expect(useAsset).toBeEnabled();
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect.poll(() => fixture.project().assets[0].role).toBe("product");
  expect(fixture.nativeActions.some((action) => action.action === "director-read-frame")).toBe(false);
});

test("工作台选材框展示用途并保留项目中已经调整的用途", async ({ page }) => {
  const voiceId = randomUUID();
  const fixture = await mockDirector(page, {
    assets: [{ ...initialAsset, name: "服装实拍.jpg", role: "document" }],
  });
  await page.route("**/api/v1/my-workspace/assistant/files", (route) =>
    route.fulfill({
      json: {
        data: [
          { id: fileId, name: "服装实拍.jpg", mime: "image/jpeg" },
          { id: voiceId, name: "主播音色样本.wav", mime: "audio/wav" },
        ].map((file) => ({
          ...file,
          createdAt: timestamp,
          source: "upload",
          size: 800,
        })),
      },
    }),
  );
  await page.goto(`${path}?project=${id}`);
  await page.getByRole("button", { name: "从工作台文件选择" }).click();
  const dialog = page.getByRole("dialog", { name: "从工作台文件选择" });
  const existing = dialog.getByRole("checkbox", { name: /服装实拍.jpg/ });
  await expect(existing).toBeDisabled();
  await expect(existing).toHaveAccessibleName(/文字资料/);
  const voice = dialog.getByRole("checkbox", { name: /主播音色样本.wav/ });
  await expect(voice).toHaveAccessibleName(/授权音色/);
  await voice.check();
  await dialog.getByRole("button", { name: "加入项目" }).click();
  const media = page.getByRole("region", { name: "素材库" });
  const voiceRow = media.getByRole("button", { name: /主播音色样本.wav/ });
  await expect(voiceRow).toContainText("授权音色");
  await expect(voiceRow).toContainText("待确认授权");
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect
    .poll(() => fixture.project().assets.map(({ role }) => role))
    .toEqual(["document", "voiceSample"]);
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
  await openStage(page, "编排分镜");
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
  await openStage(page, "交付导出");
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
  await openStage(page, "交付导出");
  await expect(
    page.getByRole("button", { name: "确认分镜并后台剪辑" }),
  ).toBeEnabled();
  expect(
    fixture.nativeActions.some((call) => call.action === "director-start"),
  ).toBe(false);
  await page.getByRole("button", { name: "确认分镜并后台剪辑" }).click();
  const delivery = page.getByRole("region", { name: "后台进度与交付" });
  await expect(delivery.getByText("后台剪辑中")).toBeVisible();
  await delivery.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(delivery.getByText("已暂停", { exact: true })).toBeVisible();
  await delivery.getByRole("button", { name: "继续", exact: true }).click();
  await expect(delivery.getByText("已导出", { exact: true })).toBeVisible();
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
  await expect
    .poll(() =>
      fixture.nativeActions.some((call) => call.action === "director-start"),
    )
    .toBe(true);
  await expect(stageButton(page, "交付导出")).toHaveAttribute("aria-current", "step");
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
  await openStage(page, "编排分镜");
  await expect(
    page.getByRole("button", { name: "新增空白分镜" }),
  ).toBeVisible();
  await openStage(page, "交付导出");
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

test("导演台在宽屏、收起侧栏和手机上与工作区内容边缘对齐", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1017 });
  await mockDirector(page, { title: "春款面料短片", assets: [initialAsset] });
  await page.goto(`${path}?project=${id}`);
  await expect(page.getByRole("img", { name: initialAsset.name })).toBeVisible();
  const director = page.locator(".director-page");
  const panel = page.locator(".director-studio");
  async function expectWorkspaceEdges() {
    const insets = await director.evaluate((root) => {
      const shell = root.closest(".content")!;
      const outer = shell.getBoundingClientRect();
      const padding = getComputedStyle(shell);
      const header = root.querySelector(".director-heading")!.getBoundingClientRect();
      const studio = root.querySelector(".director-studio")!.getBoundingClientRect();
      return {
        left: studio.left - (outer.left + parseFloat(padding.paddingLeft)),
        right: outer.right - parseFloat(padding.paddingRight) - studio.right,
        top: header.top - (outer.top + parseFloat(padding.paddingTop)),
        bottom: root.getBoundingClientRect().bottom - studio.bottom,
        overflow: root.scrollWidth - root.clientWidth,
      };
    });
    for (const [edge, difference] of Object.entries(insets)) {
      expect(Math.abs(difference), edge).toBeLessThanOrEqual(1);
    }
  }
  async function measureDesktopLayout() {
    const layout = await director.evaluate((root) => {
      const studio = root.querySelector(".director-studio")!.getBoundingClientRect();
      const preview = root.querySelector(".director-preview")!.getBoundingClientRect();
      const footer = root.parentElement!.querySelector(".page-footer")!.getBoundingClientRect();
      const outerPadding = parseFloat(getComputedStyle(root.parentElement!).paddingBottom);
      return {
        footerGap: Math.abs(studio.bottom - footer.top),
        viewportGap: Math.abs(document.documentElement.clientHeight - outerPadding - footer.bottom),
        previewShare: preview.height / studio.height,
      };
    });
    expect(layout.footerGap).toBeLessThanOrEqual(1);
    expect(layout.viewportGap).toBeLessThanOrEqual(1);
    return layout;
  }
  await expectWorkspaceEdges();
  expect((await measureDesktopLayout()).previewShare).toBeGreaterThan(0.45);
  const expandedNavWidth = (await panel.boundingBox())!.width;
  await page.screenshot({ path: testInfo.outputPath("导演台-宽屏.png"), animations: "disabled" });
  await page.getByRole("button", { name: "收起工作区导航" }).click();
  await expect(page.getByRole("button", { name: "展开工作区导航" })).toBeVisible();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(expandedNavWidth);
  await expectWorkspaceEdges();
  expect((await measureDesktopLayout()).previewShare).toBeGreaterThan(0.45);
  await page.screenshot({ path: testInfo.outputPath("导演台-收起侧栏.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectWorkspaceEdges();
  await expect(page.getByRole("button", { name: "保存项目" })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("导演台-手机.png"), animations: "disabled", fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1017 });
  await page.getByRole("button", { name: "展开工作区导航" }).click();
  await page.getByRole("button", { name: "移出项目" }).click();
  await page.getByRole("group", { name: "按用途筛选" }).getByRole("button", { name: /^商品素材/ }).click();
  await expect(page.getByText("暂无商品素材")).toBeVisible();
  await expectWorkspaceEdges();
  await measureDesktopLayout();
  await page.screenshot({ path: testInfo.outputPath("导演台-空项目.png"), animations: "disabled" });
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
  await openStage(page, "交付导出");
  await page.getByRole("button", { name: "后台剪辑", exact: true }).click();
  const delivery = page.getByRole("region", { name: "后台进度与交付" });
  await expect(delivery.getByText("后台剪辑中")).toBeVisible();
  await page.getByRole("button", { name: "人工接管", exact: true }).click();
  await expect(stageButton(page, "编排分镜")).toHaveAttribute("aria-current", "step");
  await openStage(page, "交付导出");
  await expect(delivery.getByText("已暂停", { exact: true })).toBeVisible();
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
  await expect(delivery.getByText("已暂停", { exact: true })).toBeVisible();
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
  await openStage(page, "编排分镜");
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
