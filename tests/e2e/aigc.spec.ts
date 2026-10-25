import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
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
      publicVideoProvider: "xylp",
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
async function fixture(page: Page, mode = "dark", permitted = true) {
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
          ? ["aigc.use", "aigc.manage", "analytics.read"]
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
test("native blue studio supports all five entries and omits commercial navigation", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/aigc");
  await expect(
    page.getByRole("heading", { name: "AIGC 创作空间" }),
  ).toBeVisible();
  for (const title of ["短视频制作", "电商详情页制作", "数字人"])
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
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
    .evaluate((el) => getComputedStyle(el).color);
  expect(dark).toBe("rgb(238, 240, 246)");
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
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
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
