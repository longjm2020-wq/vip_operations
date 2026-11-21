import { expect, test, type Page } from "@playwright/test";
import type { BrowserTask } from "../../packages/contracts/src/assistant-browser.js";
import {
  openPersonalAssistant,
  selectAssistantPanel,
} from "./assistant-controls.js";

declare global {
  interface Window {
    workspaceToolsMicrophoneRequests: number;
  }
}

async function fixture(
  page: Page,
  permissions = ["analytics.read", "analytics.manage", "project.read"],
  userId = "105",
) {
  const workspace = {
    version: 1,
    note: "原有备忘",
    todos: [],
    schedule: [],
    shortcuts: ["inventory"],
    available: [
      {
        id: "inventory",
        title: "库存明细",
        description: "查看库存",
        group: "运营",
        path: "/operations/vip/inventory",
      },
    ],
    defaults: { name: "个人工作台", description: "", tools: [] },
  };
  const writes: string[] = [];
  await page.addInitScript(() => {
    window.workspaceToolsMicrophoneRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.workspaceToolsMicrophoneRequests++;
      throw new DOMException("布局操作不应申请麦克风", "NotAllowedError");
    };
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (request.method() !== "GET") writes.push(path);
    if (path === "/auth/me")
      data = {
        id: userId,
        displayName: "工具菜单测试",
        username: "tools",
        permissions,
        roleCodes: [],
        csrfToken: "fixture",
      };
    if (path === "/my-workspace/appearance")
      data = { mode: "dark", version: 1 };
    if (path === "/my-workspace") {
      if (request.method() === "POST")
        Object.assign(workspace, request.postDataJSON(), {
          version: workspace.version + 1,
        });
      data = workspace;
    }
    if (path === "/my-workspace/assistant")
      data = {
        ready: true,
        version: 0,
        state: "IDLE",
        messages: [],
        model: "openai/gpt-6.1-sol",
      };
    if (path === "/my-workspace/assistant/capabilities")
      data = {
        defaultModel: "openai/gpt-6.1-sol",
        models: [
          {
            id: "openai/gpt-6.1-sol",
            name: "通用助手",
            displayName: "测试模型",
            vision: true,
          },
        ],
        imageModels: [],
      };
    if (path === "/my-workspace/assistant/voice")
      data = {
        ready: true,
        enabled: true,
        voice: "alloy",
        model: "gpt-4o-mini-tts",
        version: 1,
      };
    if (path === "/my-workspace/assistant/memory")
      data = { entries: [], version: 0 };
    if (path === "/my-workspace/assistant/desktop")
      data = { devices: [], tasks: [] };
    if (path === "/my-workspace/assistant/browser")
      data = {
        ready: false,
        workerOnline: false,
        encryptionReady: false,
        note: "",
        profile: null,
        tasks: [],
      };
    if (path === "/my-workspace/activity")
      data = { items: [], serverTime: "2026-11-03T02:00:00Z" };
    if (path === "/my-workspace/content") data = { items: [], hasMore: false };
    await route.fulfill({ json: { data } });
  });
  return { workspace, writes };
}

test("品牌标识在减少动态偏好下悬停、收起和跨模块后保持原有渐变动效", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const check = async () => {
    const brand = page.locator(".sidebar .brand-wordmark");
    await expect(brand).toBeVisible();
    await brand.hover();
    const read = () =>
      brand.evaluate((element) => {
        const style = getComputedStyle(element, "::after");
        return {
          name: style.animationName,
          play: style.animationPlayState,
          duration: style.animationDuration,
          position: style.backgroundPosition,
        };
      });
    const first = await read();
    expect(first).toMatchObject({
      name: "brand-gradient-flow",
      play: "running",
      duration: "6s",
    });
    await expect
      .poll(async () => (await read()).position)
      .not.toBe(first.position);
  };
  await page.goto("/my-workspace");
  await check();
  await page
    .getByRole("button", { name: "收起工作区导航", exact: true })
    .click();
  await expect(page.locator(".sidebar")).toHaveClass(
    /ant-layout-sider-collapsed/,
  );
  await check();
  await page.goto("/operations");
  await check();
  expect(state.writes).toEqual([]);
});

test("减少动态偏好下数字雨、小序身体和星环在悬停与输入时持续播放", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/my-workspace");
  const rain = page.locator(".workspace-world-backdrop");
  const body = page.locator(".workspace-companion .companion-body");
  const rings = page.locator(
    ".workspace-ai-core-aura, .workspace-ai-core-outer",
  );
  await expect(body).toBeVisible();
  const pixels = () =>
    rain.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
  const moving = async () => {
    const previous = await pixels();
    await expect.poll(pixels).not.toBe(previous);
    for (const node of [body, ...(await rings.all())]) {
      await expect(node).not.toHaveCSS("animation-name", "none");
      await expect(node).toHaveCSS("animation-play-state", "running");
      const time = () =>
        node.evaluate((element) =>
          Number(element.getAnimations()[0]?.currentTime),
        );
      const before = await time();
      await expect.poll(time).toBeGreaterThan(before);
    }
  };
  await page.locator(".workspace-companion .companion-launch").hover();
  await moving();
  await page
    .locator(".assistant-compose textarea")
    .fill("动画继续，草稿不发送");
  await moving();
  // Service availability changes appearance, never disables local scenery.
  await page.locator(".workspace-ai").evaluate((node) => {
    (node as HTMLElement).dataset.coreState = "unavailable";
  });
  await moving();
  expect(state.writes).toEqual([]);
});

test("减少动态偏好下小序沿卡片真实爬升再停靠", async ({ page }) => {
  const state = await fixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/my-workspace");
  const companion = page.locator(".workspace-companion");
  await expect(companion).toBeVisible();
  await expect(companion).toHaveAttribute("data-docked", "true");
  await page.clock.install();
  await page.evaluate(() => {
    const card = document.createElement("div");
    card.className = "ant-card motion-test-card";
    card.style.cssText =
      "position:fixed;left:400px;top:180px;width:320px;height:460px;background:#222;z-index:1900";
    document.body.append(card);
  });
  await page.clock.runFor(400);
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("xuti-companion-command", { detail: "climb" }),
    );
  });
  await expect(companion).toHaveAttribute("data-motion", "climbing");
  await expect(companion.locator(".companion-body")).toHaveCSS(
    "animation-name",
    "companion-climb",
  );
  const origin = await companion.boundingBox();
  await page.clock.runFor(400);
  const midway = await companion.boundingBox();
  expect(midway).not.toEqual(origin);
  await expect(companion).toHaveAttribute("data-motion", "climbing");
  await page.clock.runFor(650);
  await expect(companion).toHaveAttribute("data-motion", "idle");
  await expect(companion).toHaveAttribute("data-perched", "true");
  expect(await companion.boundingBox()).not.toEqual(midway);
  expect(state.writes).toEqual([]);
});

test("移除工具菜单后中央保留小序，旧偏好不恢复菜单、圆形入口或分支开关", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    localStorage.setItem("xuti-workspace-ring-motion:105", "disabled"),
  );
  await page.goto("/my-workspace");
  await expect(page.locator(".workspace-ai-core")).toBeVisible();
  await expect(
    page.locator(".workspace-dock, .workspace-nest-handle"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /展开工作台分支图|收起工作台分支图/ }),
  ).toHaveCount(0);
  await expect(page.locator(".personal-workspace")).toHaveAttribute(
    "data-workspace-ring-motion",
    "enabled",
  );
  await expect(
    page.getByRole("button", { name: "工作台工具", exact: true }),
  ).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(
    await page.evaluate(() => window.workspaceToolsMicrophoneRequests),
  ).toBe(0);
});

for (const width of [1440, 390]) {
  test(`浏览器右栏在 ${width}px 可准备网页指令，中栏直接添加附件，不提交任务`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/my-workspace?assistant=browser");
    await expect(page.locator(".topbar")).toHaveCSS("height", "48px");
    const browser = page.locator(".assistant-browser-panel");
    const right = page.getByRole("complementary", { name: "右侧工具栏" });
    const center = page.getByRole("region", { name: "工作台中栏" });
    const attachment = center.getByRole("button", {
      name: "附件",
      exact: true,
    });
    await expect(browser).toBeVisible();
    await expect(right.locator(".workspace-tools-header")).toBeHidden();
    await expect(right.locator(".workspace-execution-controls")).toHaveCount(0);
    await expect(
      right.getByRole("combobox", { name: "执行位置", exact: true }),
    ).toHaveCount(0);
    if (width === 390) await expect(attachment).toBeHidden();
    else await expect(attachment).toBeVisible();
    await browser
      .getByRole("button", { name: "本地浏览器", exact: true })
      .click();
    const localHelp = page.getByRole("dialog", {
      name: "在桌面端打开本地浏览器",
    });
    await expect(
      localHelp.getByRole("link", { name: "下载 Windows 桌面端" }),
    ).toHaveAttribute("href", "/downloads/xuti-desktop.zip");
    await localHelp
      .getByRole("button", { name: "关闭提示", exact: true })
      .click();

    await page
      .getByRole("button", { name: "关闭浏览器面板", exact: true })
      .click();
    await expect(right).toBeHidden();
    const rail = center.getByRole("navigation", { name: "工作台工具入口" });
    await expect(rail).toBeVisible();
    const layout = await page
      .locator(".workspace-columns")
      .evaluate((element) => {
        const box = element.getBoundingClientRect();
        const centerBox = element
          .querySelector(".workspace-center")!
          .getBoundingClientRect();
        const railBox = element
          .querySelector(".workspace-tools-rail")!
          .getBoundingClientRect();
        return {
          unusedWidth: box.width - centerBox.width,
          inside:
            railBox.left >= centerBox.left &&
            railBox.right <= centerBox.right &&
            railBox.top >= centerBox.top,
        };
      });
    expect(layout.unusedWidth).toBeLessThan(2);
    expect(layout.inside).toBe(true);

    await expect(attachment).toBeVisible();
    const draft = center.locator(".assistant-compose:visible textarea");
    await draft.fill("切换工具后仍保留的草稿");
    await expect(center.locator(".assistant-execution-hint")).toHaveCount(0);
    await expect(
      center.getByRole("combobox", { name: "执行位置", exact: true }),
    ).toHaveCount(0);
    const chooserPromise = page.waitForEvent("filechooser");
    await attachment.click();
    await (await chooserPromise).setFiles([]);
    await expect(
      page.getByRole("menuitem", { name: "网站内", exact: true }),
    ).toHaveCount(0);
    await selectAssistantPanel(page, "独立浏览器");
    await browser
      .getByRole("button", { name: "浏览器标签与会话菜单", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "让小序操作当前网页", exact: true })
      .click();
    await expect(draft).toHaveValue(
      "在小序独立浏览器中操作当前网页：切换工具后仍保留的草稿",
    );
    await draft.fill("切换工具后仍保留的草稿");
    await selectAssistantPanel(page, "独立浏览器");
    await expect(browser).toBeVisible();
    if (width === 1440) {
      await expect(rail).toBeVisible();
      await expect(
        rail.getByRole("button", { name: "展开右侧工具栏", exact: true }),
      ).toHaveCount(0);
    } else await expect(rail).toBeHidden();
    // Selecting the already visible browser must not close it or launch a task.
    await selectAssistantPanel(page, "独立浏览器");
    await expect(browser).toBeVisible();
    await selectAssistantPanel(page, "我的电脑");
    await expect(right.locator(".assistant-desktop-panel")).toBeVisible();
    await expect(right.locator(".workspace-tools-header")).toBeVisible();
    await selectAssistantPanel(page, "独立浏览器");
    await expect(browser).toBeVisible();
    await selectAssistantPanel(page, "对话设置");
    await expect(
      right.getByRole("checkbox", {
        name: "附带已保存日程与待办",
        exact: true,
      }),
    ).toBeVisible();
    await selectAssistantPanel(page, "聊天");
    await expect(draft).toHaveValue("切换工具后仍保留的草稿");
    await selectAssistantPanel(page, "独立浏览器");
    await openPersonalAssistant(page);
    await expect(draft).toHaveValue("切换工具后仍保留的草稿");
    await expect(attachment).toBeVisible();
    expect(state.writes).toEqual([]);
    expect(
      await page.evaluate(() => window.workspaceToolsMicrophoneRequests),
    ).toBe(0);
  });
}

test("桌面端地址栏默认在本机打开，也可明确选择云端浏览器", async ({ page }) => {
  const state = await fixture(page);
  const deviceId = "47d7cb0b-8975-4a1c-9f9b-b21942ec4ae2";
  const localRequests: Array<{ action: string; url?: string }> = [];
  const cloudRequests: string[] = [];
  const now = new Date().toISOString();
  let cloudTask: BrowserTask = {
    id: "1d06d29e-70ff-4fe6-a284-85748915919e",
    instruction: "浏览旧云端页面",
    status: "QUEUED",
    stage: "正在打开网页",
    step: 0,
    url: "https://example.net/previous",
    title: "",
    createdAt: now,
    updatedAt: now,
    mode: "BROWSE",
    navigationState: "STARTING",
  };
  await page.route("**/api/v1/my-workspace/assistant/browser", (route) =>
    route.fulfill({
      json: {
        data: {
          ready: true,
          canBrowse: true,
          workerOnline: true,
          encryptionReady: true,
          note: "",
          profile: null,
          tasks: [cloudTask],
        },
      },
    }),
  );
  await page.route(
    "**/api/v1/my-workspace/assistant/browser/browse",
    (route) => {
      const { url, viewport } = route.request().postDataJSON();
      cloudRequests.push(url);
      cloudTask = {
        ...cloudTask,
        instruction: `浏览 ${url}`,
        url,
        viewport,
      };
      return route.fulfill({ json: { data: cloudTask } });
    },
  );
  await page.route(
    "**/api/v1/my-workspace/assistant/browser/tasks/*/frame",
    (route) => route.fulfill({ json: { data: null } }),
  );
  await page.route("**/api/v1/my-workspace/assistant/desktop", (route) =>
    route.fulfill({
      json: {
        data: {
          devices: [
            {
              id: deviceId,
              name: "本机测试电脑",
              online: true,
              crossWindowAuthorized: true,
            },
          ],
          tasks: [],
        },
      },
    }),
  );
  await page.exposeFunction(
    "workspaceLocalBrowserRequest",
    (request: { action: string; url?: string }) => {
      if (request.action === "open-local-browser") localRequests.push(request);
      return { version: "1.2.5", connected: true, deviceId };
    },
  );
  await page.addInitScript(() => {
    const events = new EventTarget();
    Object.defineProperty(window, "xutiDesktop", {
      value: { version: "1.2.5", localBrowser: true },
    });
    Object.assign(window.chrome || (window.chrome = {}), {
      webview: {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        postMessage(request: { id: string; action: string; url?: string }) {
          void (window as any)
            .workspaceLocalBrowserRequest(request)
            .then((data: unknown) =>
              events.dispatchEvent(
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
  await page.goto("/my-workspace?assistant=browser");
  const browser = page.locator(".assistant-browser-panel");
  const local = browser.getByRole("button", {
    name: "本地浏览器",
    exact: true,
  });
  const cloud = browser.getByRole("button", {
    name: "云端独立浏览器",
    exact: true,
  });
  const submit = browser.getByRole("button", {
    name: "打开网址",
    exact: true,
  });
  const address = browser.getByRole("textbox", {
    name: "网页地址",
    exact: true,
  });
  await expect(local).toHaveAttribute("aria-pressed", "true");
  await expect(cloud).toHaveAttribute("aria-pressed", "false");
  const cloudLoading = browser
    .getByRole("status")
    .filter({ hasText: "云端浏览器正在打开网页" })
    .first();
  await expect(cloudLoading).toHaveCount(0);
  await address.fill("https://example.com/help");
  await address.press("Enter");
  await expect
    .poll(() => localRequests.map(({ url }) => url))
    .toEqual(["https://example.com/help"]);
  await expect(
    browser.getByText("已打开本地浏览器窗口", { exact: true }),
  ).toBeVisible();
  await expect(address).toHaveValue("https://example.com/help");
  await address.fill("example.com");
  await submit.click();
  await expect
    .poll(() => localRequests.map(({ url }) => url))
    .toEqual(["https://example.com/help", "https://example.com/"]);
  await browser
    .getByRole("button", { name: /打开本地窗口/ })
    .click();
  await expect
    .poll(() => localRequests.map(({ url }) => url))
    .toEqual(["https://example.com/help", "https://example.com/", undefined]);
  expect(cloudRequests).toEqual([]);
  const startTask = browser.getByRole("button", {
    name: "让小序操作本地网页",
    exact: true,
  });
  await startTask.click();
  await expect(
    page.getByText(
      "请在「我的电脑」连接这台电脑并设为常用电脑，再操作本地网页",
    ),
  ).toBeVisible();
  await expect(page.locator(".assistant-compose:visible textarea")).toHaveValue(
    "",
  );
  await page.getByRole("button", { name: "设为常用电脑", exact: true }).click();
  await selectAssistantPanel(page, "独立浏览器");
  await startTask.click();
  await expect(page.locator(".assistant-compose:visible textarea")).toHaveValue(
    "在小序本地浏览器中操作当前网页：",
  );
  expect(state.writes).toEqual([]);
  await cloud.click();
  await expect(cloud).toHaveAttribute("aria-pressed", "true");
  await expect(local).toHaveAttribute("aria-pressed", "false");
  await expect(startTask).toBeHidden();
  await expect(cloudLoading).toBeVisible();
  await browser
    .getByRole("button", { name: "打开新网址", exact: true })
    .click();
  await address.fill("https://example.org/cloud");
  await submit.click();
  await expect.poll(() => cloudRequests).toEqual(["https://example.org/cloud"]);
  await expect(cloudLoading).toBeVisible();
  expect(localRequests).toHaveLength(3);
});

test("工作台忽略旧的浏览器模式，常用电脑仅随自动分流请求传递", async ({
  page,
}) => {
  await fixture(page);
  const desktopDeviceId = "76896aaf-69d9-441d-b8c2-447c6b8cd1ce";
  await page.addInitScript((deviceId) => {
    localStorage.setItem("xuti-assistant-desktop:105", '{"mode":"browser"}');
    localStorage.setItem("xuti-assistant-preferred-desktop:105", deviceId);
  }, desktopDeviceId);
  await page.goto("/my-workspace");
  const draft = page.locator(".assistant-compose:visible textarea");
  await draft.fill("帮我整理一下今天的工作重点");
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/my-workspace/assistant",
  );
  await draft.press("Enter");
  const payload = (await submitted).postDataJSON();
  expect(payload).toMatchObject({
    autoExecution: true,
    desktopDeviceId,
    message: "帮我整理一下今天的工作重点",
  });
  expect(payload).not.toHaveProperty("browserExecution");
});

test("小序眼嘴平滑跟随和回中，眨眼口型不受减少动态限制，不启动任务", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/my-workspace");
  const figure = page.locator(".workspace-companion .companion-figure");
  await expect(figure).toBeVisible();
  const face = () =>
    figure.evaluate((element) => {
      const eye = element.querySelector(
        ".companion-pose-front .companion-eye",
      )!;
      const mouth = element.querySelector(
        ".companion-pose-front .companion-mouth",
      )!;
      return {
        x: Number.parseFloat(
          (element as HTMLElement).style.getPropertyValue("--companion-gaze-x"),
        ),
        mouthX: Number.parseFloat(
          (element as HTMLElement).style.getPropertyValue(
            "--companion-mouth-x",
          ),
        ),
        eyeTransform: new DOMMatrixReadOnly(getComputedStyle(eye).transform)
          .m41,
        mouthTransform: new DOMMatrixReadOnly(getComputedStyle(mouth).transform)
          .m41,
      };
    });
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    await page.emulateMedia({ reducedMotion });
    let previousBounds: {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null = null,
      stable = 0;
    await expect
      .poll(
        async () => {
          const next = await figure.boundingBox();
          const center = await page
            .getByRole("region", { name: "工作台中栏", exact: true })
            .boundingBox();
          if (!next || !center) return false;
          const inside =
            next.x >= center.x &&
            next.x + next.width <= center.x + center.width;
          stable =
            inside &&
            previousBounds &&
            Math.abs(next.x - previousBounds.x) +
              Math.abs(next.y - previousBounds.y) +
              Math.abs(next.width - previousBounds.width) <
              1
              ? stable + 1
              : 0;
          previousBounds = next;
          return stable >= 2;
        },
        { intervals: [100, 100, 100] },
      )
      .toBe(true);
    const bounds = await figure.boundingBox();
    if (!bounds) throw Error("No visible companion figure");
    const originX = bounds.x + bounds.width / 2;
    const originY = bounds.y + bounds.height * 0.4867;
    await page.mouse.move(originX + 180, originY);
    await expect.poll(async () => (await face()).x).toBeGreaterThan(1);
    const right = await face();
    expect(right.mouthX).toBeGreaterThan(0);
    expect(right.mouthX).toBeLessThan(right.x);
    await page.mouse.move(originX - 180, originY);
    await expect.poll(async () => (await face()).x).toBeLessThan(-1);
    const left = await face();
    expect(left.mouthX).toBeLessThan(0);
    expect(right.eyeTransform - left.eyeTransform).toBeGreaterThan(2);
    expect(right.mouthTransform - left.mouthTransform).toBeGreaterThan(1);
    const returnFrame = await figure.evaluate(async (element) => {
      const x = () =>
        Number.parseFloat(
          (element as HTMLElement).style.getPropertyValue("--companion-gaze-x"),
        );
      const before = x();
      window.dispatchEvent(new Event("blur"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      return { before, after: x() };
    });
    expect(Math.abs(returnFrame.after)).toBeGreaterThan(0);
    expect(Math.abs(returnFrame.after)).toBeLessThan(
      Math.abs(returnFrame.before),
    );
    await expect
      .poll(face)
      .toMatchObject({ x: 0, mouthX: 0, mouthTransform: 0 });
    const animations = await figure.evaluate((element) => {
      const host = element.closest<HTMLElement>(".sidebar-assistant")!;
      const previous = host.dataset.state;
      host.dataset.state = "speaking";
      const eyes = getComputedStyle(
        element.querySelector(".companion-pose-front .companion-eye-dot")!,
      ).animationName;
      const mouth = getComputedStyle(
        element.querySelector(".companion-pose-front .companion-mouth-open")!,
      ).animationName;
      if (previous === undefined) delete host.dataset.state;
      else host.dataset.state = previous;
      return { eyes, mouth };
    });
    expect(animations).toEqual({
      eyes: "companion-blink",
      mouth: "companion-talk-lips",
    });
  }
  expect(state.writes).toEqual([]);
  expect(
    await page.evaluate(() => window.workspaceToolsMicrophoneRequests),
  ).toBe(0);
});
