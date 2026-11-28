import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  createStudio,
  type Studio,
} from "../../packages/aigc-engine/index.mjs";

let engine: Studio, server: Server, apiBase: string;
const user = {
  id: "1",
  username: "creator",
  displayName: "创作测试",
  role: "super_admin",
};
test.beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aigc-browser-test-"));
  let snapshot: any;
  engine = await createStudio({
    config: {
      dataDir: dir,
      videoSecrets: {},
      videoProviders: [],
      publicVideoProvider: "bailian",
      enabledVideoProviders: ["bailian"],
      defaultVideoSelection: { providerId: "bailian", modelId: "minimax-h3" },
      bailianWorkspaceId: "ws-fixture12345678",
      maxUploadBytes: 20 * 1024 * 1024,
      maxGenerationSegments: 24,
      maxVideoSecondsPerProject: 180,
      maxClipSeconds: 120,
      defaultClipSeconds: 6,
      workerConcurrency: 1,
      workerPollMs: 2000,
    },
    persistence: {
      readState: async () => {
        if (!snapshot) throw Object.assign(Error("new"), { code: "ENOENT" });
        return structuredClone(snapshot);
      },
      writeState: async (data) => {
        snapshot = structuredClone(data);
      },
      hydrate: async () => {},
    },
    users: [user],
  });
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost");
      url.pathname = url.pathname.replace("/api/v1/aigc", "/api");
      await engine.handle(req, res, url, user);
    } catch (e: any) {
      if (!res.headersSent) {
        res.writeHead(e.statusCode || 500, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ error: e.message }));
      } else res.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  apiBase = `http://127.0.0.1:${(server.address() as any).port}`;
});
test.afterAll(async () => {
  engine?.stop();
  await new Promise<void>((r) => server?.close(() => r()));
});
async function fixture(page: Page, mode = "dark", permitted = true, commerce = false) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      p = url.pathname.replace("/api/v1", "");
    if (p.startsWith("/aigc/")) {
      if (p === "/aigc/status")
        return route.fulfill({
          json: {
            ready: true,
            compile: false,
            image: false,
            video: false,
            digital: false,
            maxUploadBytes: 20 * 1024 * 1024,
            manage: true,
          },
        });
      if (p === "/aigc/services")
        return route.fulfill({
          json: { revision: 1, encryptionReady: true, secrets: {} },
        });
      const response = await route.fetch({
        url: apiBase + url.pathname + url.search,
      });
      return route.fulfill({ response });
    }
    let data: any = [];
    if (p === "/auth/me")
      data = {
        id: "1",
        displayName: "创作测试",
        username: "creator",
        roleCodes: ["SUPER_ADMIN"],
        permissions: permitted
          ? ["aigc.use", "aigc.manage", "analytics.read", ...(commerce ? ["product.read"] : [])]
          : ["analytics.read"],
        csrfToken: "test-csrf",
      };
    if (p === "/my-workspace/appearance") {
      if (request.method() === "PUT") mode = request.postDataJSON().mode;
      data = { mode, version: 0 };
    }
    if (p === "/my-workspace/assistant")
      data = {
        ready: false,
        availabilityMessage: "尚未配置",
        messages: [],
        version: 0,
        state: "IDLE",
      };
    if (p === "/my-workspace/activity")
      data = { items: [], serverTime: new Date().toISOString() };
    if (p === "/my-workspace")
      data = { version: 0, tools: [], schedules: [], todos: [] };
    await route.fulfill({ json: { data } });
  });
}
test("H3 settings reuse a saved connection and require confirmation before one paid test", async ({
  page,
}) => {
  await fixture(page);
  let settings: any = {
    revision: 1,
    encryptionReady: true,
    bailianReuseAvailable: true,
    bailianReuseWorkspaceId: "ws-fixture12345678",
    videoRelayBaseUrl: "https://relay.example.test",
    xhaiBaseUrl: "https://images.example.test",
    secrets: { XAI_API_KEY: true },
  };
  let saved: any,
    submitted = 0;
  await page.route("**/api/v1/aigc/services", async (route) => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON();
      settings = {
        ...settings,
        revision: 2,
        bailianWorkspaceId: saved.bailianWorkspaceId,
        secrets: {
          ...settings.secrets,
          BAILIAN_VIDEO_API_KEY: true,
          XYLP_IMAGE_TT25_KEY: true,
        },
      };
    }
    await route.fulfill({ json: settings });
  });
  await page.route(
    "**/api/v1/aigc/services/bailian-video-check",
    async (route) => {
      if (route.request().method() === "POST") {
        submitted++;
        expect(route.request().postDataJSON()).toEqual({ confirmPaid: true });
      }
      await route.fulfill({
        json: {
          state: "succeeded",
          taskId: "fixture-task",
          videoUrl: "https://media.example.test/video.mp4",
        },
      });
    },
  );
  await page.goto("/aigc");
  await page.setViewportSize({ width: 680, height: 900 });
  await page.getByRole("button", { name: /服务设置/ }).click();
  const drawer = page.getByRole("dialog", { name: "AIGC 服务设置" });
  await expect(
    drawer.getByText("视频生成：MiniMax/MiniMax-H3", { exact: true }),
  ).toBeVisible();
  await expect(drawer.getByLabel("xAI 官方视频 Key")).not.toBeVisible();
  await drawer.getByRole("button", { name: /^图片生成/ }).click();
  await expect(drawer.getByLabel("TT Image 2.5 · 按量渠道 Key")).toHaveCount(0);
  await expect(drawer.getByText(/AgentAI/).first()).toBeVisible();
  await drawer.getByRole("button", { name: /^图片生成/ }).click();
  await drawer.getByText("使用已保存的百炼语音连接", { exact: true }).click();
  await expect(drawer.getByLabel("百炼北京业务空间 ID")).toHaveValue(
    "ws-fixture12345678",
  );
  await drawer.getByRole("button", { name: "保存服务配置" }).click();
  await expect(
    drawer.getByRole("button", { name: "验证 H3 视频连接" }),
  ).toBeVisible();
  expect(saved).toMatchObject({
    useSavedQwenConnection: true,
    bailianWorkspaceId: "ws-fixture12345678",
    secrets: {},
  });
  expect(saved).not.toHaveProperty("videoRelayBaseUrl");
  expect(saved).not.toHaveProperty("xhaiBaseUrl");
  expect(saved.secrets).not.toHaveProperty("XAI_API_KEY");
  await drawer.getByRole("button", { name: "验证 H3 视频连接" }).click();
  await expect(page.getByText(/刊例约 2 元，无免费额度/)).toBeVisible();
  expect(submitted).toBe(0);
  await page.getByRole("button", { name: "开始测试", exact: true }).click();
  await expect(
    drawer.getByText("H3 视频生成已验证", { exact: true }),
  ).toBeVisible();
  expect(submitted).toBe(1);
  await expect(
    drawer.getByText("任务编号：fixture-task", { exact: true }),
  ).not.toBeVisible();
  await drawer.getByText("测试详情", { exact: true }).click();
  await expect(
    drawer.getByText("任务编号：fixture-task", { exact: true }),
  ).toBeVisible();
  await drawer.getByText("测试详情", { exact: true }).click();
  expect(
    await drawer.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("aigc-connections.png"),
  });
});

test("百炼音色可独立核验与保存，保留原 H3 视频连接", async ({ page }) => {
  await fixture(page);
  const videoWorkspace = "ws-video12345678";
  const savedWorkspace = "ws-audio12345678";
  let settings = {
    revision: 4,
    encryptionReady: true,
    bailianWorkspaceId: videoWorkspace,
    bailianVoiceWorkspaceId: "",
    bailianVoiceSource: "video",
    bailianReuseAvailable: true,
    bailianReuseWorkspaceId: savedWorkspace,
    secrets: { BAILIAN_VIDEO_API_KEY: true, BAILIAN_VOICE_API_KEY: false },
  };
  const checks: string[] = [];
  await page.route("**/api/v1/aigc/services", (route) => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: settings });
  });
  await page.route(
    "**/api/v1/aigc/services/bailian-voice-connection",
    (route) => {
      expect(route.request().method()).toBe("PUT");
      expect(route.request().postDataJSON()).toEqual({
        revision: 4,
        bailianVoiceWorkspaceId: savedWorkspace,
        useSavedQwenVoiceConnection: true,
      });
      settings = {
        ...settings,
        revision: 5,
        bailianVoiceSource: "voice",
        bailianVoiceWorkspaceId: savedWorkspace,
        secrets: { ...settings.secrets, BAILIAN_VOICE_API_KEY: true },
      };
      return route.fulfill({ json: settings });
    },
  );
  await page.route("**/api/v1/aigc/services/bailian-voice-check", (route) => {
    const { source } = route.request().postDataJSON();
    checks.push(source);
    const isVideoKey =
      source === "configured" && settings.bailianVoiceSource === "video";
    return route.fulfill({
      json: {
        checkedAt: "2026-11-28T03:00:00.000Z",
        source,
        enrollment: isVideoKey
          ? {
              status: "unauthorized",
              note: "此密钥无法查询音色，请核对业务空间。",
              diagnostic: {
                action: "list_voice",
                providerStatus: 403,
                providerCode: "AccessDenied",
                providerRequestId: "req-audio-403",
              },
            }
          : { status: "reachable", note: "音色查询通过" },
        models: [
          { id: "qwen-audio-3.1-tts-plus", status: "unknown" },
          {
            id: "cosyvoice-v3.5-flash",
            status: isVideoKey ? "denied" : "authorized",
          },
        ],
      },
    });
  });
  await page.goto("/aigc?settings=bailian-voice");
  const drawer = page.getByRole("dialog", { name: "AIGC 服务设置" });
  await expect(drawer.getByLabel("百炼音色 API Key")).toBeVisible();
  await drawer
    .getByRole("button", { name: "核验音色连接", exact: true })
    .click();
  await expect(drawer.getByText("音色查询未获授权")).toBeVisible();
  await expect(drawer.getByText(/HTTP 403.*req-audio-403/)).toBeVisible();
  await drawer.getByRole("button", { name: "核验小序语音连接" }).click();
  await expect(drawer.getByText("音色查询接口可访问")).toBeVisible();
  await expect(
    drawer.getByText(/CosyVoice 3.5 Flash.*权限已核对/),
  ).toBeVisible();
  await expect(
    drawer.getByText(/Qwen Audio 3.1 TTS Plus.*权限待核对/),
  ).toBeVisible();
  await drawer.getByRole("checkbox", { name: /将小序已保存/ }).check();
  await expect(drawer.getByLabel("百炼音色北京业务空间 ID")).toHaveValue(
    savedWorkspace,
  );
  await drawer.getByRole("button", { name: "保存音色连接" }).click();
  await expect(drawer.getByText(/当前使用专用音色连接/)).toBeVisible();
  await drawer
    .getByRole("button", { name: "核验音色连接", exact: true })
    .click();
  await expect(drawer.getByText("音色查询接口可访问")).toBeVisible();
  await drawer.getByRole("button", { name: /^视频生成/ }).click();
  await expect(
    drawer.getByLabel("百炼北京业务空间 ID", { exact: true }),
  ).toHaveValue(videoWorkspace);
  expect(checks).toEqual(["configured", "saved", "configured"]);
});

test("compact studio presents four creation entries and accessible project controls", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/aigc");
  await expect(
    page.getByRole("heading", { name: "AIGC 创作空间" }),
  ).toBeVisible();
  const entries = page.getByRole("region", { name: "创作入口" });
  await expect(entries.getByRole("button")).toHaveCount(4);
  for (const title of ["短视频制作", "数字人口播", "电商详情页制作", "数字人"])
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "搜索项目" }).or(page.getByRole("textbox", { name: "搜索项目" }))).toBeVisible();
  await expect(page.getByRole("button", { name: "回收站" })).toBeVisible();
  expect(await entries.getByRole("button").first().evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(110);
  await expect(page.getByRole("menuitem", { name: /AIGC/ })).toBeVisible();
  await expect(page.getByText(/积分账户|充值|购买会员|平台管理/)).toHaveCount(
    0,
  );
  await page.getByRole("tab", { name: "站长精选" }).click();
  await expect(
    page.getByRole("heading", { name: "服装详情页", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "作品库" }).click();
  await expect(page.getByText("完成的创作会自动归档到这里")).toBeVisible();
  await page.getByRole("tab", { name: "创作工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "短视频制作", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/aigc-dark-preview.png",
    fullPage: true,
  });
  const dark = await page
    .locator(".aigc-entry")
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el);
      const red = (color: string) => Number(color.match(/\d+/u)?.[0]);
      return { readableText: red(style.color) > 225, darkPanel: red(style.backgroundColor) < 45 };
    });
  expect(dark).toEqual({ readableText: true, darkPanel: true });
});
test("uploads and saves a real video project; reload and recycle preserve it", async ({
  page,
}) => {
  await fixture(page, "light");
  await page.goto("/aigc");
  await page
    .getByRole("button", { name: /01短视频制作|短视频制作.*参考拆解/ })
    .click();
  await page.getByLabel("项目名称", { exact: true }).fill("蓝色新款短视频");
  const png = await sharp({
    create: { width: 100, height: 120, channels: 3, background: "#435ee5" },
  })
    .png()
    .toBuffer();
  await page
    .locator(".aigc-asset-input")
    .filter({ hasText: "商品原图" })
    .locator('input[type="file"]')
    .setInputFiles({ name: "商品.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("商品.png", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /保存项目/ }).click();
  await expect(page.getByText("项目已保存", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /拆解参考视频/ }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue(
    "蓝色新款短视频",
  );
  await expect(page.getByText("商品.png", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回创作空间" }).click();
  const card = page
    .locator(".aigc-project-card")
    .filter({ hasText: "蓝色新款短视频" });
  await card.getByRole("button", { name: "移入回收站" }).click();
  await expect(
    page.getByRole("heading", { name: "蓝色新款短视频" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /回收站/ }).click();
  await expect(
    page.getByRole("heading", { name: "蓝色新款短视频" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "恢复项目", exact: true }).click();
});
test("the apparel entry opens and submits a mixed product batch", async ({ page }) => {
  await fixture(page, "dark", true, true);
  let received: any;
  const batchId = randomUUID();
  const presenterId = randomUUID();
  const now = new Date().toISOString();
  const products = [
    { id: "11", styleNo: "XUTI-111", name: "XUTI-111", images: [{ id: "photo-11", url: "/photo-11" }] },
    { id: "12", styleNo: "XUTI-222", name: "XUTI-222", images: [] },
  ];
  await page.route("**/api/v1/aigc/digital-human/lip-sync", route => route.fulfill({ json: { configured: true, jobs: [] } }));
  await page.route("**/api/v1/aigc/commerce-video/**", async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/commerce-video/")[1];
    if (endpoint === "options") return route.fulfill({ json: { available: true, presenters: [{ id: presenterId, name: "测试主播", voiceKind: "default" }] } });
    if (endpoint === "products") return route.fulfill({ json: { products } });
    if (endpoint === "jobs") return route.fulfill({ json: { jobs: [] } });
    if (endpoint === "batches" && route.request().method() === "GET") return route.fulfill({ json: { batches: [] } });
    if (endpoint === "batches" || endpoint === `batches/${batchId}`) {
      if (route.request().method() === "POST") received = route.request().postDataJSON();
      return route.fulfill({ json: {
        id: batchId, createdAt: now, items: [
          { productId: "11", styleNo: "XUTI-111", job: { id: batchId, state: "queued", styleNo: "XUTI-111", scenes: [], createdAt: now } },
          { productId: "12", styleNo: "XUTI-222", message: "商品档案缺少已上传的实拍图" },
        ],
      } });
    }
    return route.fulfill({ status: 404, json: { error: "unknown fixture" } });
  });
  await page.goto("/aigc");
  await expect(page.locator(".page-footer")).toBeHidden();
  const homeSpacing = await page.locator(".aigc-page").evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const contentRect = el.closest(".content")!.getBoundingClientRect();
    return {
      leftGap: Math.round(rect.left - contentRect.left),
      rightGap: Math.round(contentRect.right - rect.right),
      topGap: Math.round(rect.top - contentRect.top),
    };
  });
  expect(homeSpacing).toEqual({ leftGap: 24, rightGap: 24, topGap: 8 });
  await page.getByRole("button", { name: /服装口播.*商品讲解/ }).click();
  await expect(page.getByRole("heading", { name: "服装口播" })).toBeVisible();
  await expect(page.getByLabel("口播制作方式")).toHaveCount(0);
  const topbarNav = page.locator(".topbar .workspace-subnav");
  await expect(topbarNav.getByRole("button", { name: "返回创作空间" })).toBeVisible();
  await expect(topbarNav.getByText("服装口播", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "口播" }).click();
  await page.getByText("按款批量", { exact: true }).click();
  const search = page.getByRole("combobox", { name: "批量选择商品" });
  await search.fill("XUTI");
  await page.getByRole("option", { name: "XUTI-111" }).click();
  await search.fill("XUTI");
  await page.getByRole("option", { name: "XUTI-222" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "视频要求" }).fill("做竖屏口播，先看领口和版型");
  await page.getByRole("button", { name: "提交批量制作" }).click();
  const progress = page.getByRole("region", { name: "批量制作进度" });
  await expect(progress.getByText("排队中")).toBeVisible();
  await expect(progress.getByText("商品档案缺少已上传的实拍图")).toBeVisible();
  expect(received).toMatchObject({ productIds: ["11", "12"], presenterId });
  await topbarNav.getByRole("button", { name: "返回创作空间" }).click();
  await expect(page.getByRole("heading", { name: "AIGC 创作空间" })).toBeVisible();
});
test("the talk-video workflow renders the four-pane integrated workbench and syncs timeline shots", async ({
  page,
}) => {
  await fixture(page, "dark", true, true);
  const workflowId = randomUUID();
  const charId = randomUUID();
  let storedWorkflow: any = null;
  let storedCharacters: any[] = [];
  await page.route("**/api/v1/aigc/digital-human/lip-sync", (route) =>
    route.fulfill({ json: { configured: true, jobs: [] } }),
  );
  await page.route("**/api/v1/aigc/commerce-video/options", (route) =>
    route.fulfill({
      json: {
        available: true,
        presenters: [],
        voices: [{ id: "bailian:v1", name: "小雅克隆音", kind: "cloned", provider: "bailian", model: "cosyvoice-v3.5-flash" }],
      },
    }),
  );
  await page.route("**/api/v1/aigc/commerce-video/characters**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith("/characters") && method === "GET") {
      return route.fulfill({ json: { characters: storedCharacters } });
    }
    if (url.pathname.endsWith("/characters") && method === "POST") {
      const body = route.request().postDataJSON();
      const created = {
        id: charId,
        ...body,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      storedCharacters = [created];
      return route.fulfill({ status: 201, json: { character: created } });
    }
    if (url.pathname.endsWith("/views") && method === "POST") {
      storedCharacters = storedCharacters.map((c) =>
        c.id === charId
          ? {
              ...c,
              faceUrl: "/mock/face.png",
              frontUrl: "/mock/front.png",
              backUrl: "/mock/back.png",
              sideUrl: "/mock/side.png",
            }
          : c,
      );
      return route.fulfill({ status: 201, json: { character: storedCharacters[0] } });
    }
    return route.fulfill({ status: 404, json: { error: "unknown char route" } });
  });
  await page.route("**/api/v1/aigc/commerce-video/workflows**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith("/catalog")) {
      return route.fulfill({
        json: {
          scriptModels: [{ id: "script-1", label: "脚本强模型", provider: "openrouter", configured: true, description: "" }],
          imageModels: [{ id: "img-1", label: "分镜图模型", configured: true, maxImages: 4, detail: "" }],
          voiceModels: [{ id: "voice-1", label: "CosyVoice 3.5", provider: "bailian", cnyPer10k: 0.8, configured: true }],
          lipSyncModels: [{ id: "lip-1", label: "fal 对口型", provider: "fal", configured: true, note: "" }],
          videoModels: [{ id: "vid-1", providerId: "bailian", modelId: "h3", label: "MiniMax H3", configured: true, supportsPrevis: true, resolutions: ["768P"], durations: [5], note: "" }],
          cozyclayBaseUrl: "",
          presenters: [],
          defaults: {
            deconstructModel: "script-1",
            scriptModel: "script-1",
            storyboardImageModel: "img-1",
            voiceModel: "voice-1",
            lipSyncModel: "lip-1",
            videoModel: "vid-1",
          },
        },
      });
    }
    if (url.pathname.endsWith("/workflows") && method === "GET") {
      return route.fulfill({ json: { workflows: storedWorkflow ? [storedWorkflow] : [] } });
    }
    if (url.pathname.endsWith("/workflows") && method === "POST") {
      storedWorkflow = {
        id: workflowId,
        title: "通勤外套爆款复刻",
        runMode: "assisted",
        stage: "draft",
        sourcePlatform: "manual",
        sourceMeta: {},
        assetsConfig: {
          productImageIds: [],
          characters: [],
          props: [],
          scenes: [],
          sceneMode: "auto",
          creativeBrief: "",
          aspectRatio: "9:16",
          targetDurationSec: 20,
          pauseBeforePrevis: false,
        },
        modelConfig: {
          deconstructModel: "script-1",
          scriptModel: "script-1",
          storyboardImageModel: "img-1",
          voiceModel: "voice-1",
          lipSyncModel: "lip-1",
          videoModel: "vid-1",
        },
        shots: [],
        cozyclayState: {},
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return route.fulfill({ json: storedWorkflow });
    }
    if (url.pathname.endsWith(`/workflows/${workflowId}`) && method === "GET") {
      return route.fulfill({ json: storedWorkflow });
    }
    if (url.pathname.endsWith(`/workflows/${workflowId}`) && method === "PATCH") {
      const body = route.request().postDataJSON();
      storedWorkflow = { ...storedWorkflow, ...body, revision: (storedWorkflow?.revision || 1) + 1 };
      return route.fulfill({ json: storedWorkflow });
    }
    if (url.pathname.endsWith(`/workflows/${workflowId}/ai-edit`) && method === "POST") {
      storedWorkflow = {
        ...storedWorkflow,
        shots: (storedWorkflow.shots || []).map((s: any, idx: number) => ({
          ...s,
          postEdit: {
            transition: idx === 0 ? "none" : "slideleft",
            transitionDurationSec: 0.4,
            filter: "warm_fashion",
            effect: idx === 0 ? "flash_in" : "vignette",
            motion: idx === 0 ? "pop_in" : "zoom_in",
            subtitleStyle: "hormozi_pop",
            titleOverlay: idx === 0 ? "显瘦神裤" : "",
          },
        })),
      };
      return route.fulfill({
        json: {
          workflow: storedWorkflow,
          summary: "已自动完成 AI 剪辑编排",
          engine: "heuristic",
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "unknown workflow fixture" } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/aigc?view=talk-video&mode=workflow");
  await expect(page.getByLabel("爆款复刻集成工作台")).toBeVisible();
  await expect(page.getByLabel("素材与能力面板")).toBeVisible();
  await expect(page.getByLabel("播放器预览区")).toBeVisible();
  await expect(page.getByLabel("参数检查器")).toBeVisible();
  await expect(page.getByLabel("多轨分镜时间轴")).toBeVisible();

  await page.getByRole("button", { name: "新建空白工作流" }).click();
  await expect(page.getByLabel("工作流名称")).toHaveValue("通勤外套爆款复刻");

  const timeline = page.getByLabel("多轨分镜时间轴");
  await timeline.getByRole("button", { name: "新增分镜" }).click();
  await expect(timeline.getByText("新增分镜 1")).toBeVisible();
  await expect(page.getByLabel("参数检查器").getByText("分镜参数 · S01")).toBeVisible();

  // 切到「素材」面板测试数字人角色库（面部 + 三视图 + 克隆音色）创建与绑定
  await page.getByRole("tab", { name: "素材" }).click();
  await expect(page.getByLabel("数字人角色库")).toBeVisible();
  await page.getByRole("button", { name: "新建角色" }).click();
  const charDialog = page.getByRole("dialog", { name: /新建数字人角色/ });
  await charDialog.getByLabel("数字人角色名称").fill("主理人小雅");
  await charDialog.getByLabel("角色人设与身形描述").fill("165cm 梨形身材，通勤松弛感");
  const mockImg = await sharp({
    create: { width: 120, height: 160, channels: 3, background: "#435ee5" },
  })
    .png()
    .toBuffer();
  await charDialog.getByLabel("上传面部特写").setInputFiles({ name: "face.png", mimeType: "image/png", buffer: mockImg });
  await charDialog.getByLabel("上传正面视图").setInputFiles({ name: "front.png", mimeType: "image/png", buffer: mockImg });
  await charDialog.getByLabel("上传背面视图").setInputFiles({ name: "back.png", mimeType: "image/png", buffer: mockImg });
  await charDialog.getByLabel("上传侧面视图").setInputFiles({ name: "side.png", mimeType: "image/png", buffer: mockImg });
  await charDialog.getByRole("button", { name: "保存至角色库" }).click();
  await expect(charDialog).toBeHidden();
  await expect(page.getByLabel("数字人角色库").getByText("主理人小雅")).toBeVisible();
  await expect(page.getByLabel("数字人角色库").getByText("4/4 视图")).toBeVisible();

  // 切到「剪辑」面板执行 AI 自动编排后期并校验导出 AE 脚本按钮与时间轴徽标
  await page.getByRole("tab", { name: "剪辑" }).click();
  await page.getByLabel("AI 剪辑指令").fill("抖音爆款快切，前3秒白闪，暖调穿搭滤镜");
  await page.getByRole("button", { name: "AI 自动编排后期" }).click();
  await expect(timeline.getByText("暖调穿搭质感")).toBeVisible();
  await expect(timeline.getByText("开场白闪冲击")).toBeVisible();
  await expect(page.getByRole("link", { name: /导出 AE 自动化脚本/ })).toBeVisible();
});
test("imports a share reference and keeps the current source when a replacement requires local upload", async ({ page }) => {
  await fixture(page);
  let submitted = 0;
  await page.route("**/api/v1/aigc/assets/import-reference", async (route) => {
    const body = route.request().postDataJSON();
    if (++submitted === 2)
      return route.fulfill({ status: 422, json: { error: "作品需要登录，请从本机上传原视频。" } });
    expect(body.shareText).toBe("去抖音看 https://v.douyin.com/some-post/");
    const asset = await engine.importPublicReference(user, body.projectId, async (file) => {
      await writeFile(file, Buffer.from("browser fixture bytes"));
      return { name: "公开参考片.mp4", mime: "video/mp4" };
    }, new AbortController().signal);
    return route.fulfill({ status: 201, json: asset });
  });
  await page.goto("/aigc");
  await page.getByRole("button", { name: /01短视频制作|短视频制作.*参考拆解/ }).click();
  await page.getByRole("button", { name: "导入分享链接" }).click();
  await page.getByLabel("参考视频链接").fill("去抖音看 https://v.douyin.com/some-post/");
  await page.getByRole("button", { name: "导入参考片" }).click();
  await expect(page.getByText("公开参考片.mp4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存项目" }).click();
  await expect(page.getByText("项目已保存", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("公开参考片.mp4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导入分享链接" }).click();
  await page.getByLabel("参考视频链接").fill("https://www.rednote.com/explore/example");
  await page.getByRole("button", { name: "导入参考片" }).click();
  await expect(page.getByText("作品需要登录，请从本机上传原视频。")).toBeVisible();
  await expect(page.getByText("公开参考片.mp4", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "替换素材" })).toBeEnabled();
});
test("ecommerce planning and digital drafts work without fake generated outputs", async ({
  page,
}) => {
  await fixture(page, "light");
  await page.goto("/aigc");
  await page.getByRole("button", { name: /电商详情页制作.*详情页/ }).click();
  await expect(page.getByLabel("项目名称", { exact: true })).toBeVisible();
  await page.getByLabel("项目名称", { exact: true }).fill("新品详情页");
  await page.getByRole("button", { name: "策划内容模块", exact: true }).click();
  await expect(page.getByText("首屏开篇", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "生成所选图片", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "返回创作空间" }).click();
  await page.getByRole("button", { name: /数字人.*形象创建/ }).click();
  await expect(
    page.getByText("数字人服务未启用", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("项目名称", { exact: true }).fill("新品口播");
  await page.getByRole("button", { name: /保存项目/ }).click();
  await expect(
    page.getByRole("button", { name: /生成口播视频/ }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "返回创作空间" }).click();
  await expect(
    page.getByRole("heading", { name: "AIGC 创作空间" }),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/aigc-light-preview.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".aigc-entry").first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    if (document.documentElement.scrollWidth <= window.innerWidth + 1) return [];
    return [...document.querySelectorAll("body *")].flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.right > window.innerWidth + 1 ? [`${element.tagName}.${String(element.className).slice(0, 90)}`] : [];
    }).slice(0, 20);
  })).toEqual([]);
  await page.screenshot({
    path: ".local/aigc-mobile-preview.png",
    fullPage: true,
  });
});
test("AIGC menu and contents are unavailable without the module permission", async ({
  page,
}) => {
  await fixture(page, "dark", false);
  await page.goto("/aigc");
  await expect(
    page.getByText("当前账号没有 AIGC 使用权限", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /AIGC/ })).toHaveCount(0);
});
