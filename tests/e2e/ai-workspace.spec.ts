import {
  openPersonalAssistant,
  selectAssistantPanel,
  setAssistantOption,
} from "./assistant-controls.js";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AssistantActivity } from "../../packages/contracts/src/assistant-activity.js";

async function openWorkspacePanel(page: Page, name: string) {
  const stage = page
    .locator(".workspace-ai-core-stage, .workspace-quiet")
    .first();
  const orbit = page.locator(".workspace-dock-orbit").first();
  const stationary = () =>
    orbit.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        style.animationName === "none" ||
        (style.animationPlayState === "paused" &&
          element
            .getAnimations()
            .every((animation) => animation.playState !== "running"))
      );
    });
  if (!(await stationary())) {
    await stage.scrollIntoViewIfNeeded();
    const box = (await stage.boundingBox())!;
    const viewport = page.viewportSize()!;
    const visibleTop = Math.max(76, box.y);
    const visibleBottom = Math.min(viewport.height - 8, box.y + box.height);
    await stage.hover({
      position: {
        x: 20,
        y: (visibleTop + visibleBottom) / 2 - box.y,
      },
    });
  }
  await expect.poll(stationary).toBe(true);
  await page.getByRole("button", { name, exact: true }).click();
}

async function dragCompanionToPanel(page: Page, panel: Locator) {
  const card = (await panel.boundingBox())!;
  const companion = page.locator(".workspace-companion");
  const launch = companion.getByRole("button", {
    name: "与小序语音对话",
    exact: true,
  });
  const start = (await launch.boundingBox())!;
  const body = (await companion.boundingBox())!;
  const left =
    card.x >= body.width + 16
      ? card.x - body.width + 8
      : card.x + card.width - 8;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(left + body.width / 2, card.y + 150 + body.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
}

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
    workspaceBinaryGlyphs: string[];
    workspaceMediaUrls: { created: string[]; revoked: string[] };
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
  await openPersonalAssistant(page);
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

test("工作台0和1背景实际滚动，减少动态效果保持静态且仍可调整视角", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.workspaceBinaryGlyphs = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      this: CanvasRenderingContext2D,
      ...args: Parameters<CanvasRenderingContext2D["fillText"]>
    ) {
      if (
        this.canvas.classList.contains("workspace-world-backdrop") &&
        window.workspaceBinaryGlyphs.length < 512
      )
        window.workspaceBinaryGlyphs.push(args[0]);
      return Reflect.apply(original, this, args);
    };
  });
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  const canvas = page.locator(".workspace-world-backdrop");
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => [...new Set(window.workspaceBinaryGlyphs)].sort()),
    )
    .toEqual(["0", "1"]);
  const pixels = () =>
    canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  const input = page
    .locator(".workspace-ai")
    .getByPlaceholder(/告诉我你想完成什么/);
  await expect(input).toBeVisible();
  for (let sample = 0; sample < 3; sample++) {
    const before = await pixels();
    await page.waitForTimeout(120);
    expect(await pixels()).not.toBe(before);
  }
  await page.screenshot({ path: ".local/workspace-binary-dark.png" });
  await input.fill("背景滚动不会发送或覆盖这段草稿");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const still = await pixels();
  await page.waitForTimeout(300);
  expect(await pixels()).toBe(still);
  const world = page.getByRole("region", {
    name: "工作台三维场景",
    exact: true,
  });
  await world.press("ArrowRight");
  await expect(world).toHaveAttribute("data-world-yaw", "4");
  await expect.poll(pixels).not.toBe(still);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const resumed = await pixels();
  await expect.poll(pixels).not.toBe(resumed);
  await page.getByRole("button", { name: "回到中心", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: /切换为[亮暗]色主题/ }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: /切换为[亮暗]色主题/ }),
  ).toHaveCount(0);
  await page.mouse.move(2, 2);
  await expect(page.locator(".ant-tooltip:visible")).toHaveCount(0);
  await page.screenshot({
    path: ".local/workspace-binary-mobile.png",
    fullPage: true,
  });
  await expect(input).toHaveValue("背景滚动不会发送或覆盖这段草稿");
  expect(fixture.assistantCalls()).toBe(0);
  expect(fixture.reads()).toBe(0);
  expect(fixture.generates()).toBe(0);
});

test("全息影像屏本机图片视频可预览，独立调整不转动场景且关闭释放媒体", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.workspaceMediaUrls = { created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = create(object);
      window.workspaceMediaUrls.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.workspaceMediaUrls.revoked.push(url);
      revoke(url);
    };
  });
  const fixture = await workspaceFixture(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
      writes.push(request.url());
  });
  await page.goto("/my-workspace");
  const worldBefore = await readWorkspaceCamera(page);
  await page.getByRole("button", { name: "全息影像屏", exact: true }).click();
  const screen = page.getByRole("dialog", { name: "全息影像屏", exact: true });
  await expect(screen).toBeVisible();
  const file = screen.getByLabel("选择全息媒体文件", { exact: true });
  await file.setInputFiles("tests/fixtures/selection-care-label.png");
  const preview = screen.locator("img");
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const imageUrl = await preview.getAttribute("src");
  expect(imageUrl).toMatch(/^blob:/);
  await screen
    .getByRole("button", { name: "放大全息影像", exact: true })
    .click();
  await expect
    .poll(async () => Number(await screen.getAttribute("data-hologram-zoom")))
    .toBeGreaterThan(1);
  const enlarged = Number(await screen.getAttribute("data-hologram-zoom"));
  await screen
    .getByRole("button", { name: "缩小全息影像", exact: true })
    .click();
  await expect
    .poll(async () => Number(await screen.getAttribute("data-hologram-zoom")))
    .toBeLessThan(enlarged);
  const rotate = screen.getByRole("button", {
    name: "调整全息影像视角",
    exact: true,
  });
  const handle = (await rotate.boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + 50,
    handle.y + handle.height / 2 + 25,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(async () =>
      Math.abs(Number(await screen.getAttribute("data-hologram-yaw"))),
    )
    .toBeGreaterThan(0);
  expect(await readWorkspaceCamera(page)).toEqual(worldBefore);
  await screen
    .getByRole("button", { name: "复位全息影像", exact: true })
    .click();
  await expect(screen).toHaveAttribute("data-hologram-yaw", "0");
  await expect(screen).toHaveAttribute("data-hologram-pitch", "0");
  await expect(screen).toHaveAttribute("data-hologram-zoom", "1");
  await rotate.press("ArrowRight");
  await expect
    .poll(async () => Number(await screen.getAttribute("data-hologram-yaw")))
    .toBeGreaterThan(0);
  await rotate.press("Home");
  await expect(screen).toHaveAttribute("data-hologram-yaw", "0");
  await page.screenshot({ path: ".local/workspace-hologram-image.png" });
  await file.setInputFiles("tests/fixtures/selection-care-label.png");
  await expect(preview).not.toHaveAttribute("src", imageUrl!);
  await expect
    .poll(() => page.evaluate(() => window.workspaceMediaUrls.revoked))
    .toContain(imageUrl);
  const repeatedUrl = await preview.getAttribute("src");
  const gif = Buffer.concat([
    Buffer.from("GIF89a"),
    Buffer.from("01000100800000000000ffffff21ff0b", "hex"),
    Buffer.from("NETSCAPE2.0"),
    Buffer.from("0301000000", "hex"),
    Buffer.from("21f904000a0000002c0000000001000100000202440100", "hex"),
    Buffer.from("21f904000a0000002c00000000010001000002024c01003b", "hex"),
  ]);
  await file.setInputFiles({
    name: "local-animation.gif",
    mimeType: "image/gif",
    buffer: gif,
  });
  await expect
    .poll(() =>
      preview.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
  await expect(preview).toHaveAttribute("alt", "local-animation.gif");
  await expect(preview).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.workspaceMediaUrls.revoked))
    .toContain(repeatedUrl);
  const gifUrl = await preview.getAttribute("src");
  await file.setInputFiles({
    name: "unsupported.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(screen.getByRole("alert")).toContainText("请选择 PNG");
  await expect(preview).toHaveAttribute("src", gifUrl!);
  // Produce a real decodable local video without a device, network or repository artifact.
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#235bcb";
    context.fillRect(0, 0, 160, 90);
    const stream = canvas.captureStream(5);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    context.fillStyle = "#8ddfff";
    context.fillRect(50, 20, 60, 50);
    await new Promise((resolve) => setTimeout(resolve, 250));
    recorder.stop();
    await finished;
    stream.getTracks().forEach((track) => track.stop());
    return [
      ...new Uint8Array(
        await new Blob(chunks, { type: "video/webm" }).arrayBuffer(),
      ),
    ];
  });
  await file.setInputFiles({
    name: "local-preview.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(bytes),
  });
  await expect
    .poll(() => page.evaluate(() => window.workspaceMediaUrls.revoked))
    .toContain(gifUrl);
  const video = screen.locator("video");
  await expect(video).toBeVisible();
  await expect
    .poll(() =>
      video.evaluate((element) => (element as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(1);
  expect(
    await video.evaluate((element) => ({
      muted: (element as HTMLVideoElement).muted,
      paused: (element as HTMLVideoElement).paused,
      controls: (element as HTMLVideoElement).controls,
      autoplay: (element as HTMLVideoElement).autoplay,
    })),
  ).toEqual({ muted: true, paused: true, controls: true, autoplay: false });
  const videoUrl = await video.getAttribute("src");
  await video.evaluate((element) => (element as HTMLVideoElement).play());
  await expect
    .poll(() =>
      video.evaluate((element) => (element as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(screen).toBeInViewport({ ratio: 0.99 });
  await page.screenshot({
    path: ".local/workspace-hologram-video-mobile.png",
    fullPage: true,
  });
  await screen
    .getByRole("button", { name: "关闭全息影像屏", exact: true })
    .click();
  await expect(screen).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.workspaceMediaUrls.revoked))
    .toContain(videoUrl);
  await page.getByRole("button", { name: "全息影像屏", exact: true }).click();
  await expect(screen).toBeVisible();
  await expect(screen.locator("img,video")).toHaveCount(0);
  await expect(
    screen.getByRole("button", { name: "选择本地媒体" }),
  ).toBeVisible();
  expect(await readWorkspaceCamera(page)).toEqual(worldBefore);
  expect(writes).toHaveLength(0);
  expect(fixture.assistantCalls()).toBe(0);
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
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await setAssistantOption(page, "播报新提醒", true);
  expect(
    await page.evaluate(() => window.assistantVoiceTest.spoken.length),
  ).toBe(0);
  await selectAssistantPanel(page, "动态反馈");
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
  await selectAssistantPanel(page, "互动对话");
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
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await selectAssistantPanel(page, "个人记忆");
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
  await selectAssistantPanel(page, "互动对话");
  await dialog.getByRole("button", { name: "助理设置", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "使用个人记忆", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "使用个人记忆", exact: true })
    .check();
  await dialog.getByRole("button", { name: "助理设置", exact: true }).click();
  await dialog
    .getByPlaceholder(/告诉我你想完成什么/)
    .fill("帮我安排明天的会议");
  await dialog.getByPlaceholder(/告诉我你想完成什么/).press("Enter");
  await expect.poll(() => fixture.submitted.length).toBe(1);
  expect(fixture.submitted[0]).toMatchObject({ includeMemory: true });
  await selectAssistantPanel(page, "个人记忆");
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
  await openPersonalAssistant(page);
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
  await selectAssistantPanel(page, "动态反馈");
  await dialog.getByRole("button", { name: "刷新助理动态" }).click();
  await selectAssistantPanel(page, "互动对话");
  await expect(action.getByText("已完成", { exact: true })).toBeVisible();
  await page.clock.runFor(4000);
  await page.screenshot({
    path: test.info().outputPath("assistant-business-dark.png"),
  });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: /切换为[亮暗]色主题/ }),
  ).toHaveCount(0);
  await openPersonalAssistant(page);
  await expect(
    dialog.getByRole("button", { name: "切换助理面板", exact: true }),
  ).toContainText("互动对话");
  await expect(dialog).toBeInViewport({ ratio: 0.99 });
  await expect(action.getByText("已完成", { exact: true })).toBeVisible();
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
    page.getByRole("button", { name: "保存工作台", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".personal-workspace h1")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "助理设置", exact: true }),
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
  await openWorkspacePanel(page, "打开个人待办");
  await page.getByLabel("待办事项", { exact: true }).fill("整理新品资料");
  await page.getByLabel("待办截止日期", { exact: true }).fill("2026-10-28");
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await openWorkspacePanel(page, "打开私有备忘");
  await page
    .getByRole("textbox", { name: "私有备忘", exact: true })
    .fill("保留在草稿中的评审要点");
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await openWorkspacePanel(page, "打开个人待办");
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
  await openWorkspacePanel(page, "打开私有备忘");
  await expect(
    page.getByRole("textbox", { name: "私有备忘", exact: true }),
  ).toHaveValue("保留在草稿中的评审要点");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect.poll(() => fixture.workspace.todos.length).toBe(1);
  expect(fixture.workspace.note).toBe("保留在草稿中的评审要点");
  await page.reload();
  await openWorkspacePanel(page, "打开个人待办");
  await expect(
    page.getByRole("checkbox", { name: "整理新品资料", exact: true }),
  ).toBeVisible();
  expect(fixture.assistantCalls()).toBe(0);
});

for (const reducedMotion of [false, true]) {
  test(`${reducedMotion ? "减少动态效果" : "星云动效"}下浮卡关闭后隐藏，重开和快速重开均保留草稿`, async ({
    page,
  }) => {
    const fixture = await workspaceFixture(page);
    await page.emulateMedia({
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    await page.goto("/my-workspace");
    await openWorkspacePanel(page, "打开私有备忘");
    const panel = page.locator(".personal-workspace-panel");
    const note = panel.getByRole("textbox", { name: "私有备忘", exact: true });
    await expect(panel).toHaveAttribute("data-panel-presence", "open");
    await note.fill("星云散去后仍保留的草稿");
    const input = await note.elementHandle();
    const exit = await panel.evaluateHandle((element) => {
      const surface = element as HTMLElement;
      const record = { leaving: false, retained: false, blocked: false };
      new MutationObserver(() => {
        if (element.getAttribute("data-panel-presence") !== "leaving") return;
        record.leaving = true;
        record.retained = !surface.hidden;
        record.blocked =
          surface.inert && element.getAttribute("aria-hidden") === "true";
      }).observe(element, {
        attributes: true,
        attributeFilter: ["data-panel-presence"],
      });
      return record;
    });
    if (reducedMotion)
      await expect
        .poll(() =>
          panel.evaluate(
            (element) =>
              element
                .getAnimations({ subtree: true })
                .filter((animation) => animation.playState === "running")
                .length,
          ),
        )
        .toBe(0);
    await panel
      .getByRole("button", { name: "收起工作台面板", exact: true })
      .click();
    await expect(panel).toHaveAttribute("data-panel-presence", "hidden");
    await expect(panel).toBeHidden();
    expect(
      await input!.evaluate((element) => ({
        connected: element.isConnected,
        value: (element as HTMLTextAreaElement).value,
      })),
    ).toEqual({ connected: true, value: "星云散去后仍保留的草稿" });
    expect(await exit.jsonValue()).toEqual(
      reducedMotion
        ? { leaving: false, retained: false, blocked: false }
        : { leaving: true, retained: true, blocked: true },
    );
    await exit.dispose();
    await openWorkspacePanel(page, "打开私有备忘");
    await expect(note).toHaveValue("星云散去后仍保留的草稿");
    await panel
      .getByRole("button", { name: "收起工作台面板", exact: true })
      .click();
    await openWorkspacePanel(page, "打开私有备忘");
    await expect(panel).toHaveAttribute("data-panel-presence", "open");
    await page.waitForTimeout(400);
    await expect(note).toBeVisible();
    await expect(note).toHaveValue("星云散去后仍保留的草稿");
    expect(fixture.workspace.note).toBe("仅自己的备忘，不发送给模型");
    expect(fixture.assistantCalls()).toBe(0);
  });
}

test("工作台与业务页共用透明宽屏对话，单输入和菜单可用且跨页保留草稿", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  const source = page
    .locator(".workspace-ai")
    .getByPlaceholder(/告诉我你想完成什么/);
  await source.fill("仍在编辑的选款会草稿");
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".assistant-screen")).toBeVisible();
  await expect(dialog.getByRole("tablist")).toHaveCount(0);
  await expect(source).toBeHidden();
  await expect(
    page.locator('textarea[placeholder*="告诉我你想完成什么"]:visible'),
  ).toHaveCount(1);
  const rootBounds = (await page.locator(".personal-workspace").boundingBox())!;
  await expect
    .poll(() =>
      dialog.evaluate((element) =>
        Math.abs(
          element.getBoundingClientRect().width -
            (element as HTMLElement).offsetWidth,
        ),
      ),
    )
    .toBeLessThanOrEqual(0.5);
  const workspacePanelWidth = (await dialog.boundingBox())!.width;
  expect(workspacePanelWidth).toBeGreaterThan(rootBounds.width * 0.7);
  const input = dialog.getByPlaceholder(/告诉我你想完成什么/);
  await expect(input).toHaveValue("仍在编辑的选款会草稿");
  await input.fill("继续编辑但尚未发送");
  for (const [section, label] of [
    ["任务与文件", "我的文件"],
    ["个人记忆", "新增记忆"],
    ["动态反馈", "刷新助理动态"],
  ] as const) {
    await selectAssistantPanel(page, section);
    await expect(
      dialog.getByRole("button", { name: "切换助理面板", exact: true }),
    ).toContainText(section);
    await expect(
      section === "任务与文件"
        ? dialog.getByRole("heading", { name: label, exact: true })
        : dialog.getByRole("button", { name: label }),
    ).toBeVisible();
  }
  await selectAssistantPanel(page, "互动对话");
  await expect(input).toHaveValue("继续编辑但尚未发送");
  await page.screenshot({ path: ".local/workspace-chat-screen-dark.png" });
  const exitMotion = await page
    .locator(".assistant-screen .ant-drawer-content-wrapper")
    .evaluateHandle((element) => {
      const record = { opacitySeconds: 0 };
      element.addEventListener("transitionend", (event) => {
        const transition = event as TransitionEvent;
        if (event.target === element && transition.propertyName === "opacity")
          record.opacitySeconds = transition.elapsedTime;
      });
      return record;
    });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await exitMotion.jsonValue()).opacitySeconds).toBeGreaterThanOrEqual(
    0.3,
  );
  expect((await exitMotion.jsonValue()).opacitySeconds).toBeLessThanOrEqual(
    0.4,
  );
  await exitMotion.dispose();
  await expect(source).toBeVisible();
  await expect(source).toHaveValue("继续编辑但尚未发送");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: /切换为[亮暗]色主题/ }),
  ).toHaveCount(0);
  await openPersonalAssistant(page);
  await expect(input).toHaveValue("继续编辑但尚未发送");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  await expect(page).toHaveURL(/operations$/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: /切换为[亮暗]色主题/ }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "展开小序状态与动态", exact: true })
    .click();
  await page.getByRole("button", { name: "文字对话", exact: true }).click();
  await expect(dialog).toBeInViewport({ ratio: 0.99 });
  await expect(page.locator(".assistant-screen")).toBeVisible();
  await expect(page.locator(".assistant-screen .ant-drawer-section")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect
    .poll(async () =>
      Math.abs((await dialog.boundingBox())!.width - workspacePanelWidth),
    )
    .toBeLessThanOrEqual(1);
  await expect
    .poll(async () => {
      const settled = (await dialog.boundingBox())!;
      return Math.abs(
        settled.x + settled.width / 2 - page.viewportSize()!.width / 2,
      );
    })
    .toBeLessThanOrEqual(1);
  await expect(
    page.locator('textarea[placeholder*="告诉我你想完成什么"]:visible'),
  ).toHaveCount(1);
  await expect(input).toHaveValue("继续编辑但尚未发送");
  await selectAssistantPanel(page, "个人记忆");
  await expect(
    dialog.getByRole("region", { name: "个人记忆管理", exact: true }),
  ).toBeVisible();
  await selectAssistantPanel(page, "互动对话");
  await expect(input).toHaveValue("继续编辑但尚未发送");
  await page.screenshot({ path: ".local/business-chat-screen-dark.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeInViewport({ ratio: 0.99 });
  await expect(input).toHaveValue("继续编辑但尚未发送");
  await expect(
    page.locator('textarea[placeholder*="告诉我你想完成什么"]:visible'),
  ).toHaveCount(1);
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(391);
  await page.screenshot({
    path: ".local/business-chat-screen-mobile.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  expect(fixture.assistantCalls()).toBe(0);
});

test("齿轮收纳隐私选项且默认不发送，手机可选择后发送并保持唯一输入", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace");
  const context = page.getByRole("checkbox", {
    name: "附带已保存日程与待办",
    exact: true,
  });
  const memory = page.getByRole("checkbox", {
    name: "使用个人记忆",
    exact: true,
  });
  await expect(context).toBeHidden();
  await expect(memory).toBeHidden();
  const gear = page.getByRole("button", { name: "助理设置", exact: true });
  await gear.click();
  await expect(context).not.toBeChecked();
  await expect(memory).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "智能语音", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "打开个人助理", exact: true }),
  ).toBeVisible();
  await gear.click();
  const source = page
    .locator(".workspace-ai")
    .getByPlaceholder(/告诉我你想完成什么/);
  await source.fill("未勾选时询问工作安排");
  await source.press("Enter");
  await expect.poll(() => fixture.submitted.length).toBe(1);
  expect(fixture.submitted[0]).toMatchObject({
    includePersonalContext: false,
    includeMemory: false,
  });
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(dialog).toBeVisible();
  await setAssistantOption(page, "附带已保存日程与待办", true);
  await setAssistantOption(page, "使用个人记忆", true);
  const input = dialog.getByPlaceholder(/告诉我你想完成什么/);
  await input.fill("勾选后使用已保存安排和记忆");
  await input.press("Enter");
  await expect.poll(() => fixture.submitted.length).toBe(2);
  expect(fixture.submitted[1]).toMatchObject({
    includePersonalContext: true,
    includeMemory: true,
  });
  expect(JSON.stringify(fixture.submitted)).not.toContain("仅自己的备忘");
  await expect(
    page.locator('textarea[placeholder*="告诉我你想完成什么"]:visible'),
  ).toHaveCount(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(391);
  await page.screenshot({
    path: ".local/workspace-chat-screen-mobile.png",
    fullPage: true,
  });
});

test("功能圆环实际围绕核心公转，悬停与打开浮卡暂停以便操作", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page, {
    permissions: ["analytics.read", "analytics.manage", "project.read"],
  });
  await page.goto("/my-workspace");
  const menu = page.getByRole("navigation", { name: "工作台功能面板" });
  const orbit = menu.locator(".workspace-dock-orbit").first();
  const entry = menu.getByRole("button", { name: "打开日程", exact: true });
  await page.mouse.move(5, 5);
  await expect(orbit).toHaveCSS("animation-play-state", "running");
  const initial = (await entry.boundingBox())!;
  await expect
    .poll(async () => {
      const moving = (await entry.boundingBox())!;
      return Math.hypot(moving.x - initial.x, moving.y - initial.y);
    })
    .toBeGreaterThan(6);
  const stage = (await page.locator(".workspace-ai-core-stage").boundingBox())!;
  await page.mouse.move(stage.x + 10, stage.y + 10);
  await expect(orbit).toHaveCSS("animation-play-state", "paused");
  const hovered = (await entry.boundingBox())!;
  await page.waitForTimeout(350);
  const stillHovered = (await entry.boundingBox())!;
  expect(
    Math.hypot(stillHovered.x - hovered.x, stillHovered.y - hovered.y),
  ).toBeLessThan(1);
  await entry.click();
  await expect(
    page.getByRole("dialog", { name: "日程", exact: true }),
  ).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(menu).toHaveAttribute("data-paused", "true");
  await expect(orbit).toHaveCSS("animation-play-state", "paused");
  const opened = (await entry.boundingBox())!;
  await page.waitForTimeout(350);
  const stillOpened = (await entry.boundingBox())!;
  expect(
    Math.hypot(stillOpened.x - opened.x, stillOpened.y - opened.y),
  ).toBeLessThan(1);
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.locator(".workspace-title").click();
  await page.mouse.move(5, 5);
  await expect(menu).toHaveAttribute("data-paused", "false");
  await expect(orbit).toHaveCSS("animation-play-state", "running");
  expect(fixture.assistantCalls()).toBe(0);
});

test("圆环入口打开可拖动浮卡，保留屏幕边距与草稿并在卡片内保存", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page, {
    permissions: ["analytics.read", "analytics.manage", "project.read"],
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/my-workspace");
  const menu = page.getByRole("navigation", { name: "工作台功能面板" });
  await expect(menu.getByRole("button")).toHaveCount(5);
  await openWorkspacePanel(page, "打开私有备忘");
  const panel = page.getByRole("dialog", { name: "私有备忘", exact: true });
  await expect(panel).toHaveClass(/personal-workspace-panel/);
  await expect(panel).not.toHaveAttribute("aria-modal", "true");
  const note = panel.getByRole("textbox", { name: "私有备忘", exact: true });
  await note.fill("移动浮卡后仍保留的备忘");
  const initial = (await panel.boundingBox())!;
  const core = (await page.locator(".workspace-ai-core").boundingBox())!;
  const entrance = (await menu
    .getByRole("button", { name: "打开私有备忘", exact: true })
    .locator(".workspace-dock-label")
    .boundingBox())!;
  const onLeft = entrance.x + entrance.width / 2 < core.x + core.width / 2;
  if (onLeft && core.x - 24 - initial.width >= 24)
    expect(initial.x + initial.width).toBeLessThanOrEqual(core.x - 23);
  else if (!onLeft && core.x + core.width + 24 + initial.width <= 1416)
    expect(initial.x).toBeGreaterThanOrEqual(core.x + core.width + 23);
  expect(initial.x).toBeGreaterThanOrEqual(23);
  expect(initial.x + initial.width).toBeLessThanOrEqual(1417);
  const handle = panel.getByRole("button", {
    name: "移动工作台面板",
    exact: true,
  });
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(1435, 995, { steps: 12 });
  await page.mouse.up();
  const dragged = (await panel.boundingBox())!;
  expect(
    Math.hypot(dragged.x - initial.x, dragged.y - initial.y),
  ).toBeGreaterThan(20);
  expect(dragged.x).toBeGreaterThanOrEqual(23);
  expect(dragged.y).toBeGreaterThanOrEqual(23);
  expect(dragged.x + dragged.width).toBeLessThanOrEqual(1417);
  expect(dragged.y + dragged.height).toBeLessThanOrEqual(977);
  await expect(note).toHaveValue("移动浮卡后仍保留的备忘");
  await handle.press("Home");
  await expect
    .poll(async () => {
      const restored = (await panel.boundingBox())!;
      return Math.hypot(restored.x - initial.x, restored.y - initial.y);
    })
    .toBeLessThan(2);
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await openWorkspacePanel(page, "打开私有备忘");
  await expect(note).toHaveValue("移动浮卡后仍保留的备忘");
  expect(fixture.workspace.note).toBe("仅自己的备忘，不发送给模型");
  await panel.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect
    .poll(() => fixture.workspace.note)
    .toBe("移动浮卡后仍保留的备忘");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const mobile = (await panel.boundingBox())!;
      return (
        mobile.x >= 11 &&
        mobile.y >= 11 &&
        mobile.x + mobile.width <= 379 &&
        mobile.y + mobile.height <= 833
      );
    })
    .toBe(true);
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
  await openWorkspacePanel(page, "打开常用工具");
  await expect(
    page.getByRole("dialog", { name: "常用工具", exact: true }),
  ).toBeVisible();
  expect(fixture.contentReads()).toBe(0);
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await openWorkspacePanel(page, "打开我的内容");
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
  await openWorkspacePanel(page, "打开日程");
  await page.getByRole("button", { name: "日程下个月", exact: true }).click();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await openWorkspacePanel(page, "打开我的内容");
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
  await openWorkspacePanel(page, "打开日程");
  await expect(page.locator(".schedule-month > strong")).toHaveText(
    "2026 年 11 月",
  );
  expect(fixture.assistantCalls()).toBe(0);
});

test("小序在业务页记住浮动位置，返回工作台巢穴保留同一形象，跨页面日程仍需保存", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/operations");
  const companion = page.locator(".workspace-companion");
  await expect(companion).toHaveAttribute("data-docked", "false");
  await expect(
    companion.getByRole("button", { name: "与小序语音对话", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".sidebar .sidebar-assistant")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("companion-operations-dark.png"),
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
  const assistantElement = await companion
    .locator(".sidebar-assistant")
    .elementHandle();
  const savedPosition = await page.evaluate(() =>
    localStorage.getItem("xuti-companion-position:105"),
  );
  expect(savedPosition).not.toBeNull();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "我的工作台", exact: true })
    .click();
  await expect(companion).toHaveAttribute("data-docked", "true");
  await expect(companion).toHaveCount(1);
  await expect(
    page.locator(".workspace-companion .sidebar-assistant"),
  ).toHaveCount(1);
  expect(
    await assistantElement!.evaluate((element) => element.isConnected),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("xuti-companion-position:105"),
    ),
  ).toBe(savedPosition);
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  await expect(companion).toHaveAttribute("data-docked", "false");
  expect(
    await assistantElement!.evaluate((element) => element.isConnected),
  ).toBe(true);
  await expect
    .poll(async () => {
      const returned = (await companion.boundingBox())!;
      return Math.hypot(returned.x - moved.x, returned.y - moved.y);
    })
    .toBeLessThan(2);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("xuti-companion-position:105"),
    ),
  ).toBe(savedPosition);
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
  await expect(companion).toHaveAttribute("data-docked", "true");
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
  await openPersonalAssistant(page);
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
  await expect(
    page.getByRole("button", { name: "换个位置", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "回到巢穴", exact: true }),
  ).toHaveCount(0);
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
  await openWorkspacePanel(page, "打开日程");
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
  await openWorkspacePanel(page, "打开日程");
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
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await dialog.getByRole("button", { name: "助理设置", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "附带已保存日程与待办", exact: true }),
  ).not.toBeChecked();
  await dialog.getByRole("button", { name: "助理设置", exact: true }).click();
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
  await openPersonalAssistant(page);
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
  await openWorkspacePanel(page, "打开私有备忘");
  await expect(
    page.getByRole("textbox", { name: "私有备忘", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await openWorkspacePanel(page, "打开个人待办");
  await page.getByLabel("待办事项", { exact: true }).fill("核对库存");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "核对库存", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await openWorkspacePanel(page, "打开常用工具");
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
  await workspaceFixture(page, {
    permissions: ["analytics.read", "analytics.manage", "project.read"],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-workspace");
  await expect(
    page.getByRole("button", { name: "助理设置", exact: true }),
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
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "发送给个人助理" }),
  ).toBeVisible();
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await openWorkspacePanel(page, "打开个人待办");
  const todo = page.getByRole("dialog", { name: "个人待办", exact: true });
  await expect(todo.getByLabel("待办事项", { exact: true })).toBeVisible();
  expect((await todo.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(391);
  await todo
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  for (const [entryName, title] of [
    ["打开日程", "日程"],
    ["打开个人待办", "个人待办"],
    ["打开私有备忘", "私有备忘"],
    ["打开常用工具", "常用工具"],
    ["打开我的内容", "我创建的内容"],
  ]) {
    const entry = page.getByRole("button", { name: entryName, exact: true });
    await expect(entry).toBeInViewport({ ratio: 0.99 });
    // A visually present 3D entry must receive the normal center click,
    // including the two backmost entries beside the transparent core.
    await entry.click();
    const panel = page.getByRole("dialog", { name: title, exact: true });
    await expect(panel).toBeVisible();
    await panel
      .getByRole("button", { name: "收起工作台面板", exact: true })
      .click();
    await expect(panel).toBeHidden();
  }
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
  await openPersonalAssistant(page);
  const assistant = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(
    assistant.getByRole("button", { name: "发送给个人助理" }),
  ).toBeVisible();
  expect((await assistant.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  await assistant.getByRole("button", { name: "关闭", exact: true }).click();
  await openWorkspacePanel(page, "打开日程");
  await page.getByRole("button", { name: "新增日程", exact: true }).click();
  const calendar = page.getByRole("dialog", { name: "新增日程", exact: true });
  await expect(calendar.getByLabel("日程名称", { exact: true })).toBeVisible();
  expect((await calendar.boundingBox())!.width).toBeLessThanOrEqual(390.05);
  await calendar.getByRole("button", { name: "取消", exact: true }).click();
  await expect(calendar).not.toBeVisible();
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.locator(".workspace-ai").scrollIntoViewIfNeeded();
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
async function readWorkspaceCamera(page: Page) {
  return page.locator(".personal-workspace").evaluate((element) => ({
    pitch: Number(element.getAttribute("data-world-pitch")),
    yaw: Number(element.getAttribute("data-world-yaw")),
    x: Number(element.getAttribute("data-world-x")),
    y: Number(element.getAttribute("data-world-y")),
    zoom: Number(element.getAttribute("data-world-zoom")),
    mode: element.getAttribute("data-world-mode"),
  }));
}

async function workspaceBlankPoint(page: Page) {
  return page.locator(".personal-workspace").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const core = element
      .querySelector(".workspace-ai-core")!
      .getBoundingClientRect();
    const left = Math.max(8, bounds.left),
      right = Math.min(innerWidth - 8, bounds.right);
    const top = Math.max(80, bounds.top),
      bottom = Math.min(innerHeight - 8, bounds.bottom);
    for (const horizontal of [0.04, 0.96, 0.12, 0.88]) {
      for (const vertical of [0.25, 0.4, 0.55, 0.7]) {
        const x = left + (right - left) * horizontal,
          y = top + (bottom - top) * vertical;
        const target = document.elementFromPoint(x, y);
        if (
          target &&
          element.contains(target) &&
          !target.closest(
            "button,a,input,textarea,select,[contenteditable=true],.personal-welcome,.assistant-compose,.personal-workspace-panel,.workspace-companion,.workspace-world-controls",
          ) &&
          !(
            x > core.left - 25 &&
            x < core.right + 25 &&
            y > core.top - 25 &&
            y < core.bottom + 25
          )
        )
          return { x, y };
      }
    }
    throw new Error(
      "No visible workspace background away from the core is available",
    );
  });
}

async function dragWorkspace(
  page: Page,
  dx: number,
  dy: number,
  options: { shift?: boolean; button?: "left" | "middle" } = {},
) {
  const point = await workspaceBlankPoint(page);
  if (options.shift) await page.keyboard.down("Shift");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button: options.button || "left" });
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 8 });
  await page.mouse.up({ button: options.button || "left" });
  if (options.shift) await page.keyboard.up("Shift");
}

const defaultWorkspaceCamera = {
  pitch: 0,
  yaw: 0,
  x: 0,
  y: 0,
  zoom: 1,
  mode: "rotate",
};

test("工作台空白处控制整个三维场景，无界旋转平移、缩放与复位不移动固定输入和日期", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.goto("/my-workspace");
  const world = page.getByRole("region", {
    name: "工作台三维场景",
    exact: true,
  });
  const input = page
    .locator(".workspace-ai")
    .getByPlaceholder(/告诉我你想完成什么/);
  const date = page.locator(".workspace-date");
  const controls = page.locator(".workspace-world-controls");
  await expect
    .poll(() => readWorkspaceCamera(page))
    .toEqual(defaultWorkspaceCamera);
  const fixed = {
    input: await input.boundingBox(),
    date: await date.boundingBox(),
    controls: await controls.boundingBox(),
  };
  await dragWorkspace(page, 900, 600);
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).pitch)
    .toBe(-75);
  await dragWorkspace(page, 900, -1200);
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).pitch)
    .toBe(75);
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).yaw)
    .toBeGreaterThan(360);
  await world.press("Home");
  await expect
    .poll(() => readWorkspaceCamera(page))
    .toEqual(defaultWorkspaceCamera);
  for (let index = 0; index < 3; index++)
    await dragWorkspace(page, 600, 400, { shift: true });
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).x)
    .toBeGreaterThan(1440);
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).y)
    .toBeGreaterThan(1000);
  expect((await readWorkspaceCamera(page)).yaw).toBe(0);
  const beforeMiddle = await readWorkspaceCamera(page);
  await dragWorkspace(page, -160, -80, { button: "middle" });
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).x)
    .toBeLessThan(beforeMiddle.x);
  await page.getByRole("button", { name: "平移场景", exact: true }).click();
  await expect(world).toHaveAttribute("data-world-mode", "pan");
  const beforePan = await readWorkspaceCamera(page);
  await dragWorkspace(page, 90, 50);
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).x)
    .toBeGreaterThan(beforePan.x);
  await page.getByRole("button", { name: "旋转场景", exact: true }).click();
  await expect(world).toHaveAttribute("data-world-mode", "rotate");
  const point = await workspaceBlankPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -20000);
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).zoom)
    .toBe(1.65);
  await page.mouse.wheel(0, 20000);
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).zoom)
    .toBe(0.55);
  await page.getByRole("button", { name: "放大场景", exact: true }).click();
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).zoom)
    .toBeGreaterThan(0.55);
  const zoomed = (await readWorkspaceCamera(page)).zoom;
  await page.getByRole("button", { name: "缩小场景", exact: true }).click();
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).zoom)
    .toBeLessThan(zoomed);
  for (const [element, expected] of [
    [input, fixed.input],
    [date, fixed.date],
    [controls, fixed.controls],
  ] as const) {
    const actual = (await element.boundingBox())!;
    expect(
      Math.abs(actual.x - expected!.x) + Math.abs(actual.y - expected!.y),
    ).toBeLessThan(1);
  }
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "回到中心", exact: true }).click();
  await expect
    .poll(() => readWorkspaceCamera(page))
    .toEqual(defaultWorkspaceCamera);
  await world.press("ArrowRight");
  await expect(world).toHaveAttribute("data-world-yaw", "4");
  await world.press("Shift+ArrowDown");
  await expect(world).toHaveAttribute("data-world-y", "40");
  await world.press("Home");
  await expect
    .poll(() => readWorkspaceCamera(page))
    .toEqual(defaultWorkspaceCamera);
  expect(fixture.assistantCalls()).toBe(0);
});

test("输入文字、拖动小序和浮卡不会误转三维场景或启动语音", async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.addInitScript(() => {
    Reflect.set(window, "workspaceMicrophoneRequests", 0);
    navigator.mediaDevices.getUserMedia = async () => {
      Reflect.set(
        window,
        "workspaceMicrophoneRequests",
        Number(Reflect.get(window, "workspaceMicrophoneRequests")) + 1,
      );
      throw new DOMException(
        "Scene interactions must not request a microphone",
        "NotAllowedError",
      );
    };
  });
  await page.goto("/my-workspace");
  const world = page.getByRole("region", {
    name: "工作台三维场景",
    exact: true,
  });
  await world.press("ArrowRight");
  await expect(world).toHaveAttribute("data-world-yaw", "4");
  const camera = await readWorkspaceCamera(page);
  const input = page
    .locator(".workspace-ai")
    .getByPlaceholder(/告诉我你想完成什么/);
  await input.fill("输入草稿，Home仅移动文字光标");
  await input.press("Control+A");
  await input.press("Home");
  expect(await readWorkspaceCamera(page)).toEqual(camera);
  const companion = page.locator(".workspace-companion");
  const robot = (await companion
    .getByRole("button", { name: "与小序语音对话", exact: true })
    .boundingBox())!;
  await page.mouse.move(robot.x + robot.width / 2, robot.y + robot.height / 2);
  await page.mouse.down();
  await page.mouse.move(1300, 870, { steps: 10 });
  await page.mouse.up();
  await expect(companion).toHaveAttribute("data-docked", "false");
  expect(await readWorkspaceCamera(page)).toEqual(camera);
  await openWorkspacePanel(page, "打开私有备忘");
  const note = page.getByRole("textbox", { name: "私有备忘", exact: true });
  await note.fill("浮卡仍可独立输入和滚动\n".repeat(30));
  const handle = page.getByRole("button", {
    name: "移动工作台面板",
    exact: true,
  });
  const panel = page.locator(".personal-workspace-panel");
  const before = (await panel.boundingBox())!;
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grip.x + grip.width / 2 - 180,
    grip.y + grip.height / 2 + 90,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => {
      const after = (await panel.boundingBox())!;
      return Math.hypot(after.x - before.x, after.y - before.y);
    })
    .toBeGreaterThan(40);
  await note.hover();
  await page.mouse.wheel(0, 300);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  expect(await readWorkspaceCamera(page)).toEqual(camera);
  await expect(input).toHaveValue("输入草稿，Home仅移动文字光标");
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "workspaceMicrophoneRequests"),
    ),
  ).toBe(0);
  expect(fixture.assistantCalls()).toBe(0);
});

test("手机触摸与减少动态效果仍可操作三维场景，移出中心后固定控件可恢复且页面不溢出", async ({
  page,
  context,
}) => {
  const fixture = await workspaceFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/my-workspace");
  const world = page.getByRole("region", {
    name: "工作台三维场景",
    exact: true,
  });
  const client = await context.newCDPSession(page);
  await client.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 2,
  });
  const touchDrag = async (dx: number, dy: number) => {
    const point = await workspaceBlankPoint(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: point.x, y: point.y }],
    });
    for (let step = 1; step <= 6; step++)
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: point.x + (dx * step) / 6, y: point.y + (dy * step) / 6 },
        ],
      });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };
  await touchDrag(80, 40);
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).yaw)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).pitch)
    .toBeLessThan(0);
  await expect(page.locator(".workspace-ai-core-aura")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.getByRole("button", { name: "平移场景", exact: true }).click();
  for (let index = 0; index < 5; index++) await touchDrag(110, 60);
  await expect
    .poll(async () => (await readWorkspaceCamera(page)).x)
    .toBeGreaterThan(390);
  const reset = page.getByRole("button", { name: "回到中心", exact: true });
  await expect(reset).toBeInViewport({ ratio: 1 });
  await expect(page.locator(".workspace-date")).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await reset.click();
  await expect
    .poll(() => readWorkspaceCamera(page))
    .toEqual(defaultWorkspaceCamera);
  await expect(world.locator(".workspace-ai-core")).toBeInViewport({
    ratio: 0.99,
  });
  await page
    .locator(".workspace-ai")
    .getByPlaceholder(/告诉我你想完成什么/)
    .fill("触摸操作后的输入仍可用");
  expect(await readWorkspaceCamera(page)).toEqual(defaultWorkspaceCamera);
  expect(fixture.assistantCalls()).toBe(0);
  await client.detach();
});

test("小序在助理遮罩前仍可操作，攀爬浮卡后保持草稿且目标关闭会回落", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.addInitScript(() => {
    Reflect.set(window, "companionMicrophoneRequests", 0);
    navigator.mediaDevices.getUserMedia = async () => {
      Reflect.set(
        window,
        "companionMicrophoneRequests",
        Number(Reflect.get(window, "companionMicrophoneRequests")) + 1,
      );
      throw new DOMException("本用例不应申请麦克风", "NotAllowedError");
    };
  });
  await page.goto("/my-workspace");
  const companion = page.locator(".workspace-companion");
  const voice = companion.getByRole("button", {
    name: "与小序语音对话",
    exact: true,
  });
  const badge = companion.getByRole("button", {
    name: "展开小序状态与动态",
    exact: true,
  });
  const instance = await companion
    .locator(".sidebar-assistant")
    .elementHandle();
  await openPersonalAssistant(page);
  const assistant = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(assistant).toBeVisible();
  for (const control of [voice, badge]) {
    await expect
      .poll(() =>
        control.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      )
      .toBe(true);
  }
  const suggestion = assistant.getByRole("button", {
    name: /查看我参与的项目进度/,
  });
  const suggestionBox = (await suggestion.boundingBox())!;
  // The right side of this suggestion overlaps the original nest position.
  // Opening the drawer must leave the whole button usable, not just its text.
  await suggestion.click({
    position: { x: suggestionBox.width * 0.7, y: suggestionBox.height / 2 },
  });
  await expect(assistant.getByPlaceholder(/告诉我你想完成什么/)).toHaveValue(
    "查看我参与的项目进度",
  );
  await badge.click();
  for (const name of ["换个位置", "攀爬组件", "回到巢穴"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await expect(
    page.getByRole("button", { name: "文字对话", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: ".local/companion-over-assistant.png" });
  await badge.click();
  await assistant.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(
    page.locator(".personal-assistant-drawer .ant-drawer-content-wrapper"),
  ).toBeHidden();

  await openWorkspacePanel(page, "打开私有备忘");
  const panel = page.getByRole("dialog", { name: "私有备忘", exact: true });
  const note = panel.getByRole("textbox", { name: "私有备忘", exact: true });
  await note.fill("攀爬前尚未保存的备忘");
  const camera = await readWorkspaceCamera(page);
  await dragCompanionToPanel(page, panel);
  await expect(companion).toHaveAttribute("data-motion", "climbing");
  await page.waitForTimeout(350);
  const during = (await companion.boundingBox())!;
  await expect(companion).toHaveAttribute("data-perched", "true");
  await expect(companion).toHaveAttribute("data-motion", "idle");
  const perched = (await companion.boundingBox())!;
  const card = (await panel.boundingBox())!;
  expect(perched.y).toBeLessThan(during.y - 20);
  const side = await companion.getAttribute("data-climb-side");
  const overlap =
    side === "left"
      ? perched.x + perched.width - card.x
      : card.x + card.width - perched.x;
  expect(overlap).toBeGreaterThan(0);
  expect(overlap).toBeLessThanOrEqual(14);
  expect(perched.y).toBeGreaterThan(card.y);
  expect(perched.y + perched.height).toBeLessThan(card.y + card.height);
  await note.fill("停靠时仍能编辑的备忘");
  await page.screenshot({ path: ".local/companion-perched-note.png" });
  await panel
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await expect(companion).toHaveAttribute("data-perched", "false");
  await expect(companion).toBeInViewport({ ratio: 1 });
  await openWorkspacePanel(page, "打开私有备忘");
  await expect(note).toHaveValue("停靠时仍能编辑的备忘");
  expect(await readWorkspaceCamera(page)).toEqual(camera);
  expect(await instance!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.locator(".sidebar-assistant")).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "companionMicrophoneRequests"),
    ),
  ).toBe(0);
  expect(fixture.assistantCalls()).toBe(0);
});

test("减少动态效果下拖近卡片立即停靠，移动卡片时跟随且不转动场景", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/my-workspace");
  await openWorkspacePanel(page, "打开私有备忘");
  const panel = page.getByRole("dialog", { name: "私有备忘", exact: true });
  const companion = page.locator(".workspace-companion");
  const camera = await readWorkspaceCamera(page);
  await dragCompanionToPanel(page, panel);
  await expect(companion).toHaveAttribute("data-perched", "true");
  await expect(companion).toHaveAttribute("data-motion", "idle");
  const resting = (await companion.boundingBox())!;
  await page.waitForTimeout(150);
  expect(await companion.boundingBox()).toEqual(resting);
  const handle = panel.getByRole("button", {
    name: "移动工作台面板",
    exact: true,
  });
  // The memo orbit sits just above this edge; move into the clear space below.
  await handle.press("ArrowDown");
  await expect
    .poll(async () => (await companion.boundingBox())!.y)
    .toBeCloseTo(resting.y + 16, 0);
  await expect(companion).toHaveAttribute("data-perched", "true");
  expect(await readWorkspaceCamera(page)).toEqual(camera);
  await expect(
    page.getByRole("region", { name: "小序语音", exact: true }),
  ).toHaveCount(0);
  expect(fixture.assistantCalls()).toBe(0);
});

test("工作台圆环是小序巢穴，可离巢移动与召回，文字和动态入口仍可用", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.clock.install({ time: new Date("2026-10-26T02:00:00Z") });
  fixture.activities.push({
    id: "project:core",
    kind: "project",
    title: "核心入口项目进展",
    detail: "已验收 1 / 3 项",
    href: "/projects/1",
    at: "2026-10-26T02:00:00Z",
    status: "info",
  });
  await page.goto("/my-workspace");
  const core = page.locator(".workspace-ai-core");
  const companion = page.locator(".workspace-companion");
  await expect(companion).toHaveAttribute("data-docked", "true");
  await expect(page.locator(".workspace-companion")).toHaveCount(1);
  await expect(page.locator(".sidebar-assistant")).toHaveCount(1);
  const voice = companion.getByRole("button", {
    name: "与小序语音对话",
    exact: true,
  });
  await expect(voice).toBeVisible();
  const frame = (await core.boundingBox())!;
  const robot = (await voice.boundingBox())!;
  expect(
    Math.abs(robot.x + robot.width / 2 - frame.x - frame.width / 2),
  ).toBeLessThan(12);
  expect(
    Math.abs(robot.y + robot.height / 2 - frame.y - frame.height / 2),
  ).toBeLessThan(12);
  const assistantElement = await companion
    .locator(".sidebar-assistant")
    .elementHandle();
  await voice.press("ArrowRight");
  await page.clock.runFor(1200);
  await expect(companion).toHaveAttribute("data-docked", "false");
  await expect(companion).toHaveAttribute("data-motion", "idle");
  await expect(
    core.getByRole("button", { name: "召唤小序", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".sidebar-assistant")).toHaveCount(1);
  expect(
    await assistantElement!.evaluate((element) => element.isConnected),
  ).toBe(true);
  await voice.press("ArrowDown");
  await page.clock.runFor(1200);
  await expect(companion).toHaveAttribute("data-motion", "idle");
  await voice.press("Home");
  await page.clock.runFor(1200);
  await expect(companion).toHaveAttribute("data-docked", "true");
  await voice.press("ArrowRight");
  await page.clock.runFor(1200);
  await core.getByRole("button", { name: "召唤小序", exact: true }).click();
  await page.clock.runFor(1200);
  await expect(companion).toHaveAttribute("data-docked", "true");
  expect(
    await assistantElement!.evaluate((element) => element.isConnected),
  ).toBe(true);
  await page
    .locator(".workspace-ai")
    .getByPlaceholder(/告诉我你想完成什么/)
    .focus();
  await expect(
    page.locator(".workspace-ai").getByPlaceholder(/告诉我你想完成什么/),
  ).toBeFocused();
  await companion.getByRole("button", { name: "展开小序状态与动态" }).click();
  await page
    .getByRole("button", { name: "查看助理动态反馈", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(
    dialog.getByRole("button", { name: "切换助理面板", exact: true }),
  ).toContainText("动态反馈");
  await expect(
    dialog.getByText("核心入口项目进展", { exact: true }),
  ).toBeVisible();
  expect(fixture.assistantCalls()).toBe(0);
});

test("小序可从巢穴拖出或用方向键离巢，Home归巢且移动不误触语音", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.clock.install({ time: new Date("2026-10-26T02:00:00Z") });
  await page.goto("/my-workspace");
  const companion = page.locator(".workspace-companion");
  const voice = companion.getByRole("button", {
    name: "与小序语音对话",
    exact: true,
  });
  await expect(companion).toHaveAttribute("data-docked", "true");
  const robot = (await voice.boundingBox())!;
  await page.mouse.move(robot.x + robot.width / 2, robot.y + robot.height / 2);
  await page.mouse.down();
  await page.mouse.move(100, 630, { steps: 12 });
  await page.mouse.up();
  await page.clock.runFor(1200);
  await expect(companion).toHaveAttribute("data-docked", "false");
  const saved = await page.evaluate(() =>
    localStorage.getItem("xuti-companion-position:105"),
  );
  expect(saved).not.toBeNull();
  await voice.press("Home");
  await page.clock.runFor(1200);
  await expect(companion).toHaveAttribute("data-docked", "true");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("xuti-companion-position:105"),
    ),
  ).toBe(saved);
  await voice.press("ArrowRight");
  await page.clock.runFor(1200);
  await expect(companion).toHaveAttribute("data-docked", "false");
  const world = page.getByRole("region", {
    name: "工作台三维场景",
    exact: true,
  });
  const nest = page.locator(".workspace-ai-companion-slot");
  const worldBounds = (await world.boundingBox())!;
  const nestBounds = (await nest.boundingBox())!;
  const steps = Math.round(
    (nestBounds.x + nestBounds.width / 2 - worldBounds.x / 2) / 40,
  );
  for (let step = 0; step < steps; step++) await world.press("Shift+ArrowLeft");
  await page.clock.runFor(50);
  const clipped = (await nest.boundingBox())!;
  // The nest is still inside the browser, but the workspace clips it behind the sidebar.
  expect(clipped.x).toBeGreaterThanOrEqual(0);
  expect(clipped.x + clipped.width).toBeLessThan(worldBounds.x);
  expect(clipped.y).toBeGreaterThanOrEqual(0);
  expect(clipped.y + clipped.height).toBeLessThan(page.viewportSize()!.height);
  await voice.press("Home");
  await page.clock.runFor(1200);
  await expect(companion).toHaveAttribute("data-docked", "true");
  await expect
    .poll(() => readWorkspaceCamera(page))
    .toEqual(defaultWorkspaceCamera);
  await expect(nest).toBeInViewport({ ratio: 1 });
  expect((await nest.boundingBox())!.x).toBeGreaterThanOrEqual(worldBounds.x);
  await expect(
    page.getByRole("region", { name: "小序语音", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: /AI 个人助理/ })).toHaveCount(
    0,
  );
  expect(fixture.assistantCalls()).toBe(0);
});

test("桌面空闲小序会探头离巢与归巢，自主动作不调用模型或麦克风且不覆盖手动位置", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.clock.install({ time: new Date("2026-10-26T02:00:00Z") });
  const saved = JSON.stringify({ x: 0.08, y: 0.65 });
  await page.addInitScript((position) => {
    localStorage.setItem("xuti-companion-position:105", position);
    Reflect.set(window, "workspaceMicrophoneRequests", 0);
    navigator.mediaDevices.getUserMedia = async () => {
      Reflect.set(
        window,
        "workspaceMicrophoneRequests",
        Number(Reflect.get(window, "workspaceMicrophoneRequests")) + 1,
      );
      throw new DOMException(
        "Movement must not request a microphone",
        "NotAllowedError",
      );
    };
  }, saved);
  await page.goto("/my-workspace");
  const companion = page.locator(".workspace-companion");
  await expect(companion).toHaveAttribute("data-docked", "true");
  await companion.evaluate((element) => {
    const motions: string[] = [],
      homes: string[] = [];
    Reflect.set(window, "workspaceObservedMotions", motions);
    Reflect.set(window, "workspaceObservedHomes", homes);
    new MutationObserver(() => {
      motions.push(element.getAttribute("data-motion") || "");
      homes.push(element.getAttribute("data-docked") || "");
    }).observe(element, {
      attributes: true,
      attributeFilter: ["data-motion", "data-docked"],
    });
  });
  await page.mouse.move(5, 5);
  await page.clock.runFor(26000);
  await expect(companion).toHaveAttribute("data-docked", "false");
  expect(
    await page.evaluate(() => Reflect.get(window, "workspaceObservedMotions")),
  ).toEqual(expect.arrayContaining(["peek", "jumping"]));
  await page.clock.runFor(55000);
  const homes: string[] = await page.evaluate(() =>
    Reflect.get(window, "workspaceObservedHomes"),
  );
  expect(homes.indexOf("false")).toBeGreaterThanOrEqual(0);
  expect(homes.lastIndexOf("true")).toBeGreaterThan(homes.indexOf("false"));
  expect(
    await page.evaluate(() =>
      localStorage.getItem("xuti-companion-position:105"),
    ),
  ).toBe(saved);
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "workspaceMicrophoneRequests"),
    ),
  ).toBe(0);
  expect(fixture.assistantCalls()).toBe(0);
});

test("输入、弹窗与后台任务运行期间小序不自主离巢", async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.clock.install({ time: new Date("2026-10-26T02:00:00Z") });
  fixture.activities.push({
    id: "task:busy",
    kind: "task",
    title: "库存同步",
    detail: "处理中",
    href: "/operations/vip/inventory",
    at: "2026-10-26T02:00:00Z",
    status: "running",
  });
  await page.goto("/my-workspace");
  const companion = page.locator(".workspace-companion");
  await expect(page.locator(".workspace-ai")).toHaveAttribute(
    "data-core-state",
    "working",
  );
  await page.mouse.move(5, 5);
  await page.clock.runFor(70000);
  await expect(companion).toHaveAttribute("data-docked", "true");
  fixture.activities[0].status = "completed";
  await companion.getByRole("button", { name: "展开小序状态与动态" }).click();
  await page
    .getByRole("button", { name: "查看助理动态反馈", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await dialog
    .getByRole("button", { name: "刷新助理动态", exact: true })
    .click();
  await page.clock.runFor(35000);
  await expect(companion).toHaveAttribute("data-docked", "true");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  // Complete the modal close transition and its focus restoration before typing.
  await page.clock.runFor(1200);
  await expect(dialog).toBeHidden();
  const input = page
    .locator(".workspace-ai")
    .getByPlaceholder(/告诉我你想完成什么/);
  await input.fill("正在整理工作");
  await expect(input).toBeFocused();
  await page.mouse.move(5, 5);
  await page.clock.runFor(35000);
  await expect(input).toBeFocused();
  await expect(companion).toHaveAttribute("data-docked", "true");
  expect(fixture.assistantCalls()).toBe(0);
});

for (const reducedMotion of [false, true]) {
  test(`${reducedMotion ? "减少动态效果" : "手机"}下小序不自主离巢，手动出来与召唤仍可用`, async ({
    page,
  }) => {
    const fixture = await workspaceFixture(page);
    await page.clock.install({ time: new Date("2026-10-26T02:00:00Z") });
    if (reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
    else await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/my-workspace");
    const companion = page.locator(".workspace-companion");
    await expect(companion).toHaveAttribute("data-docked", "true");
    await page.mouse.move(5, 5);
    await page.clock.runFor(70000);
    await expect(companion).toHaveAttribute("data-docked", "true");
    await expect(companion).toHaveAttribute("data-motion", "idle");
    await companion
      .getByRole("button", { name: "与小序语音对话", exact: true })
      .press("ArrowRight");
    // Manual keyboard placement is allowed to overlap the nest; clear its return button.
    if (!reducedMotion)
      for (let step = 0; step < 8; step++)
        await companion
          .getByRole("button", { name: "与小序语音对话", exact: true })
          .press("ArrowRight");
    await page.clock.runFor(1200);
    await expect(companion).toHaveAttribute("data-docked", "false");
    await expect(companion).toHaveAttribute("data-motion", "idle");
    const atRest = await companion.boundingBox();
    await page.mouse.move(5, 5);
    await page.clock.runFor(70000);
    expect(await companion.boundingBox()).toEqual(atRest);
    const viewport = page.viewportSize()!;
    expect(atRest!.x).toBeGreaterThanOrEqual(0);
    expect(atRest!.x + atRest!.width).toBeLessThanOrEqual(viewport.width);
    expect(atRest!.y + atRest!.height).toBeLessThanOrEqual(viewport.height);
    await page.getByRole("button", { name: "召唤小序", exact: true }).click();
    await page.clock.runFor(1200);
    await expect(companion).toHaveAttribute("data-docked", "true");
    expect(fixture.assistantCalls()).toBe(0);
  });
}

test("业务页小序空闲游动，对话与减少动态效果暂停，角标展开反馈", async ({
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
  await page.goto("/operations");
  const companion = page.locator(".workspace-companion");
  await expect(companion).toBeVisible();
  await expect(companion).toHaveAttribute("data-docked", "false");
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
  await badge.click();
  await page.getByRole("button", { name: "文字对话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  const input = dialog.getByPlaceholder(/告诉我你想完成什么/);
  await input.fill("正在输入");
  const paused = await companion.boundingBox();
  await page.clock.runFor(35000);
  expect(await companion.boundingBox()).toEqual(paused);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const reduced = await companion.boundingBox();
  await page.clock.runFor(35000);
  expect(await companion.boundingBox()).toEqual(reduced);
  await badge.click();
  await expect(badge).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("button", { name: "查看助理动态反馈" }),
  ).toBeVisible();
  await page.locator(".workspace-title").click();
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
  await expect(page.locator(".workspace-companion")).toHaveAttribute(
    "data-docked",
    "true",
  );
  await expect(page.locator(".sidebar-assistant")).toHaveCount(1);
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
  await page
    .locator(".workspace-ai-core-stage")
    .hover({ position: { x: 20, y: 140 } });
  await page.screenshot({
    path: ".local/world-workspace-dark.png",
  });
  const world = page.getByRole("region", {
    name: "工作台三维场景",
    exact: true,
  });
  for (let index = 0; index < 8; index++) await world.press("ArrowRight");
  for (let index = 0; index < 3; index++) await world.press("ArrowUp");
  await expect(world).toHaveAttribute("data-world-yaw", "32");
  await expect(world).toHaveAttribute("data-world-pitch", "-12");
  await page.screenshot({ path: ".local/world-workspace-rotated.png" });
  await page.getByRole("button", { name: "回到中心", exact: true }).click();
  await expect
    .poll(() => readWorkspaceCamera(page))
    .toEqual(defaultWorkspaceCamera);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: /切换为[亮暗]色主题/ }),
  ).toHaveCount(0);
  await openWorkspacePanel(page, "打开日程");
  await expect(
    page.getByRole("dialog", { name: "日程", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: ".local/world-workspace-schedule.png",
  });
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(core).toBeVisible();
  await expect(
    page
      .locator(".workspace-companion")
      .getByRole("button", { name: "与小序语音对话", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: /切换为[亮暗]色主题/ }),
  ).toHaveCount(0);
  const mobile = (await core.boundingBox())!;
  expect(mobile.x).toBeGreaterThanOrEqual(0);
  expect(mobile.x + mobile.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(391);
  await page
    .locator(".workspace-ai-core-stage")
    .hover({ position: { x: 20, y: 140 } });
  await page.screenshot({
    path: ".local/world-workspace-mobile.png",
    fullPage: true,
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
  const assistantElement = await companion
    .locator(".sidebar-assistant")
    .elementHandle();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "我的工作台", exact: true })
    .click();
  await expect(companion).toHaveAttribute("data-docked", "true");
  expect(
    await assistantElement!.evaluate((element) => element.isConnected),
  ).toBe(true);
  await expect(reminder).toHaveCount(0);
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  await expect(companion).toHaveAttribute("data-docked", "false");
  expect(
    await assistantElement!.evaluate((element) => element.isConnected),
  ).toBe(true);
  await page.clock.runFor(31000);
  await expect(reminder).toHaveCount(0);
  expect(fixture.assistantCalls()).toBe(0);
});

test("核心呼吸光晕与轻颤持续循环，操作时暂停且减少动态效果关闭装饰动画", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/my-workspace");
  const core = page.getByRole("group", { name: "小序巢穴三维视角" });
  const slot = core.locator(".workspace-ai-companion-slot");
  const decorations = [
    {
      element: core.locator(".workspace-ai-core-aura"),
      name: "workspace-core-breathe",
    },
    {
      element: core.locator(".workspace-ai-core-resonance"),
      name: "workspace-core-resonate",
    },
    {
      element: core.locator(".workspace-ai-core-orbits"),
      name: "workspace-core-shiver",
    },
  ];
  await page.mouse.move(5, 5);
  for (const { element, name } of decorations) {
    await expect(element).toHaveCSS("animation-name", name);
    await expect(element).toHaveCSS("animation-iteration-count", "infinite");
    await expect(element).toHaveCSS("animation-play-state", "running");
  }
  const geometry = {
    core: await core.boundingBox(),
    slot: await slot.boundingBox(),
  };
  const opacity = Number(
    await decorations[0].element.evaluate(
      (element) => getComputedStyle(element).opacity,
    ),
  );
  await expect
    .poll(async () =>
      Math.abs(
        Number(
          await decorations[0].element.evaluate(
            (element) => getComputedStyle(element).opacity,
          ),
        ) - opacity,
      ),
    )
    .toBeGreaterThan(0.015);
  expect(await core.boundingBox()).toEqual(geometry.core);
  expect(await slot.boundingBox()).toEqual(geometry.slot);

  const frame = (await core.boundingBox())!;
  await core.hover({
    position: { x: frame.width * 0.18, y: frame.height * 0.18 },
  });
  for (const { element } of decorations)
    await expect(element).toHaveCSS("animation-play-state", "paused");
  await page.mouse.down();
  await page.mouse.move(
    frame.x + frame.width * 0.18 + 45,
    frame.y + frame.height * 0.18 + 25,
    { steps: 5 },
  );
  await expect(page.locator(".personal-workspace")).toHaveAttribute(
    "data-world-dragging",
    "true",
  );
  for (const { element } of decorations)
    await expect(element).toHaveCSS("animation-play-state", "paused");
  await page.mouse.up();
  await expect(page.locator(".personal-workspace")).not.toHaveAttribute(
    "data-world-dragging",
    "true",
  );
  await page.locator(".workspace-title").click();
  await page.mouse.move(5, 5);
  for (const { element } of decorations)
    await expect(element).toHaveCSS("animation-play-state", "running");
  await page
    .locator(".workspace-ai")
    .getByPlaceholder(/告诉我你想完成什么/)
    .focus();
  for (const { element } of decorations)
    await expect(element).toHaveCSS("animation-play-state", "paused");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const { element } of decorations)
    await expect(element).toHaveCSS("animation-name", "none");
  expect(fixture.assistantCalls()).toBe(0);
});

test("页底新提醒按实际换行高度留在窗口内，拖动后整块形象与提醒避开输入框", async ({
  page,
}) => {
  const fixture = await workspaceFixture(page);
  await page.clock.install({ time: new Date("2026-10-26T02:00:00Z") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/my-workspace");
  const companion = page.locator(".workspace-companion");
  const handle = companion.getByRole("button", {
    name: "与小序语音对话",
    exact: true,
  });
  const move = async (x: number, y: number) => {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.up();
    await page.clock.runFor(1200);
  };
  await move(1350, 985);
  await expect(companion).toHaveAttribute("data-docked", "false");
  const parked = (await companion.boundingBox())!;
  expect(parked.y + parked.height).toBeGreaterThan(900);
  fixture.activities.push({
    id: "schedule:long-reminder",
    kind: "schedule",
    title:
      "选款评审即将开始请提前准备样衣款式资料和库存清单并联系相关负责人确认参会",
    detail: "请核对会议安排",
    href: "/my-workspace",
    at: "2026-10-26T02:30:00Z",
    status: "attention",
  });
  await page.clock.runFor(31000);
  const reminder = companion.locator(".companion-reminder");
  await expect(reminder).toBeVisible();
  expect(Array.from((await reminder.textContent()) || "")).toHaveLength(32);
  expect((await reminder.boundingBox())!.height).toBeGreaterThan(40);
  const input = page
    .locator(".workspace-ai")
    .getByPlaceholder(/告诉我你想完成什么/);
  const safe = async () => {
    const body = (await companion.boundingBox())!;
    const message = (await reminder.boundingBox())!;
    const field = (await input.boundingBox())!;
    const viewport = page.viewportSize()!;
    const bounds = {
      left: Math.min(body.x, message.x),
      top: Math.min(body.y, message.y),
      right: Math.max(body.x + body.width, message.x + message.width),
      bottom: Math.max(body.y + body.height, message.y + message.height),
    };
    return (
      bounds.left >= 7 &&
      bounds.top >= 7 &&
      bounds.right <= viewport.width - 7 &&
      bounds.bottom <= viewport.height - 7 &&
      !(
        bounds.left < field.x + field.width &&
        bounds.right > field.x &&
        bounds.top < field.y + field.height &&
        bounds.bottom > field.y
      )
    );
  };
  await expect.poll(safe).toBe(true);
  const field = (await input.boundingBox())!;
  // Drop immediately above the composer: the wrapped reminder must also be avoided.
  await move(field.x + field.width / 2, field.y - 68);
  await expect(reminder).toBeVisible();
  await expect.poll(safe).toBe(true);
  expect(fixture.assistantCalls()).toBe(0);
});

test("权限在页内刷新后圆环入口随AI与普通工作区切换，私有备忘草稿保留", async ({
  page,
}) => {
  const permissions = ["analytics.read", "analytics.manage", "project.read"];
  const fixture = await workspaceFixture(page, { permissions });
  await page.goto("/my-workspace");
  const originalPage = await page
    .locator(".personal-workspace")
    .elementHandle();
  const menu = page.getByRole("navigation", { name: "工作台功能面板" });
  const note = page.getByRole("textbox", { name: "私有备忘", exact: true });
  const draft = "权限更新期间保留的未保存备忘";
  await expect(page.locator(".workspace-ai-core")).toBeVisible();
  await expect(menu.getByRole("button")).toHaveCount(5);
  await openWorkspacePanel(page, "打开私有备忘");
  await note.fill(draft);

  let elapsed = 0;
  const refreshPermissions = async (next: string[]) => {
    permissions.splice(0, permissions.length, ...next);
    // The real auth query becomes stale after 10s and refetches on tab visibility.
    elapsed += 11000;
    await page.clock.setFixedTime(
      new Date(Date.parse("2026-10-26T02:00:00Z") + elapsed),
    );
    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/v1/auth/me" &&
          response.status() === 200,
      ),
      page.evaluate(() => window.dispatchEvent(new Event("visibilitychange"))),
    ]);
  };
  await refreshPermissions(["analytics.read", "project.read"]);
  await expect(page.locator(".workspace-ai-core")).toHaveCount(0);
  await expect(page.locator(".workspace-quiet")).toBeVisible();
  await expect(page.locator(".workspace-quiet .workspace-dock")).toHaveCount(1);
  await expect(menu.getByRole("button")).toHaveCount(5);
  await expect(note).toHaveValue(draft);
  expect(await originalPage!.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  for (const [entry, title] of [
    ["打开日程", "日程"],
    ["打开个人待办", "个人待办"],
    ["打开常用工具", "常用工具"],
    ["打开我的内容", "我创建的内容"],
    ["打开私有备忘", "私有备忘"],
  ]) {
    // Floating cards may cover another orbit entry; close before selecting the next.
    await page
      .getByRole("button", { name: "收起工作台面板", exact: true })
      .click();
    await openWorkspacePanel(page, entry);
    await expect(
      page.getByRole("dialog", { name: title, exact: true }),
    ).toBeVisible();
  }
  await expect(note).toHaveValue(draft);
  expect(fixture.workspace.note).toBe("仅自己的备忘，不发送给模型");

  await refreshPermissions(["analytics.read"]);
  await expect(menu.getByRole("button")).toHaveCount(4);
  await expect(
    menu.getByRole("button", { name: "打开我的内容", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "收起工作台面板", exact: true })
    .click();
  await openWorkspacePanel(page, "打开私有备忘");
  await expect(note).toHaveValue(draft);

  await refreshPermissions([
    "analytics.read",
    "analytics.manage",
    "project.read",
  ]);
  await expect(page.locator(".workspace-quiet")).toHaveCount(0);
  await expect(page.locator(".workspace-ai-core")).toBeVisible();
  await expect(
    page.locator(".workspace-ai-orbit-slot .workspace-dock"),
  ).toHaveCount(1);
  await expect(menu.getByRole("button")).toHaveCount(5);
  expect(await originalPage!.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect(note).toHaveValue(draft);
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect.poll(() => fixture.workspace.note).toBe(draft);
  expect(fixture.assistantCalls()).toBe(0);
});
