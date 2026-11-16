import { expect, test, type Page } from "@playwright/test";
import {
  openPersonalAssistant,
  selectAssistantExecution,
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
  test(`浏览器简洁右栏在 ${width}px 可返回中栏选择执行位置并访问其他工具，不提交任务`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/my-workspace?assistant=browser");
    const browser = page.locator(".assistant-browser-panel");
    const right = page.getByRole("complementary", { name: "右侧工具栏" });
    const center = page.getByRole("region", { name: "工作台中栏" });
    const execution = center.getByRole("combobox", {
      name: "执行位置",
      exact: true,
    });
    await expect(browser).toBeVisible();
    await expect(right.locator(".workspace-tools-header")).toBeHidden();
    await expect(right.locator(".workspace-execution-controls")).toHaveCount(0);
    await expect(
      right.getByRole("combobox", { name: "执行位置", exact: true }),
    ).toHaveCount(0);
    if (width === 390) await expect(execution).toBeHidden();
    else await expect(execution).toBeVisible();

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

    await selectAssistantExecution(page, "网站内");
    await expect(execution).toBeVisible();
    const draft = center.locator(".assistant-compose:visible textarea");
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
    await expect(execution).toBeVisible();
    expect(state.writes).toEqual([]);
    expect(
      await page.evaluate(() => window.workspaceToolsMicrophoneRequests),
    ).toBe(0);
  });
}

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
