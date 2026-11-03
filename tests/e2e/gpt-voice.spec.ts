import {
  openPersonalAssistant,
  setAssistantOption,
} from "./assistant-controls.js";
import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    gptVoiceTest: {
      starts: number;
      stops: number;
      silence: () => void;
      speak: () => void;
    };
  }
}

async function fixture(
  page: Page,
  options: {
    denied?: boolean;
    configured?: boolean;
    dark?: boolean;
    missed?: boolean;
    speechError?: boolean;
    navigation?: boolean;
    reply?: string;
  } = {},
) {
  await page.addInitScript(
    ({ denied }) => {
      window.gptVoiceTest = {
        starts: 0,
        stops: 0,
        silence: () => {},
        speak: () => {},
      };
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: async () => {
          window.gptVoiceTest.starts++;
          if (denied)
            throw new DOMException("permission denied", "NotAllowedError");
          // Real Web Audio and AudioWorklet, with a synthetic microphone instead of a device.
          const context = new AudioContext({ sampleRate: 24000 });
          await context.resume();
          const oscillator = context.createOscillator(),
            gain = context.createGain(),
            output = context.createMediaStreamDestination();
          gain.gain.value = 0.1;
          oscillator.connect(gain);
          gain.connect(output);
          oscillator.start();
          window.gptVoiceTest.silence = () => {
            gain.gain.value = 0;
          };
          window.gptVoiceTest.speak = () => {
            gain.gain.value = 0.1;
          };
          const track = output.stream.getAudioTracks()[0],
            originalStop = track.stop.bind(track);
          track.stop = () => {
            window.gptVoiceTest.stops++;
            originalStop();
            void context.close().catch(() => {});
          };
          return output.stream;
        },
      });
    },
    { denied: !!options.denied },
  );
  let status = {
    ready: options.configured !== false,
    enabled: options.configured !== false,
    model: "openai/gpt-audio",
    voice: "coral",
    apiKeyConfigured: options.configured !== false,
    encryptionReady: true,
    verifiedAt: options.configured === false ? null : "2026-11-03T00:00:00Z",
    error: "",
    canManage: true,
    version: 0,
    maxSeconds: 25,
    assistantReady: true,
  };
  const appearance = { version: 0, mode: options.dark ? "dark" : "light" };
  const turns: Record<string, unknown>[] = [],
    writes: Record<string, unknown>[] = [],
    speeches: Record<string, unknown>[] = [];
  const assistant = {
    ready: true,
    availabilityMessage: "已就绪",
    model: "openai/gpt-6.1-sol",
    version: 0,
    state: "IDLE",
    error: "",
    messages: [] as object[],
  };
  const pcm = Buffer.alloc(24000 * 2 * 4);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(Math.sin(i / 20) * 500), i * 2);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace("/api/v1", "");
    let data: unknown = [];
    if (path === "/auth/me")
      data = {
        id: "1",
        username: "test",
        displayName: "语音测试",
        roleCodes: ["SUPER_ADMIN"],
        permissions: [
          "analytics.read",
          "analytics.manage",
          "product.read",
          "inventory.read",
        ],
        csrfToken: "fixture",
      };
    if (path === "/my-workspace/appearance") {
      if (request.method() === "POST")
        Object.assign(appearance, request.postDataJSON(), {
          version: appearance.version + 1,
        });
      data = appearance;
    }
    if (path === "/my-workspace")
      data = {
        version: 0,
        note: "",
        todos: [],
        schedule: [],
        shortcuts: [],
        available: [],
        defaults: { name: "工作台", description: "", tools: [] },
      };
    if (path === "/my-workspace/content") data = { items: [], hasMore: false };
    if (path === "/my-workspace/activity")
      data = { items: [], serverTime: "2026-11-03T00:00:00Z" };
    if (path === "/my-workspace/assistant/memory")
      data = { version: 0, entries: [] };
    if (path === "/my-workspace/assistant") {
      if (request.method() === "POST") {
        assistant.messages.push(
          {
            id: crypto.randomUUID(),
            role: "user",
            text: request.postDataJSON().message,
          },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: "你好，我是小序。今天有什么想一起完成的？",
          },
        );
        assistant.version++;
      }
      data = assistant;
    }
    if (path === "/my-workspace/assistant/voice/speech") {
      const body = request.postDataJSON();
      speeches.push(body);
      expect(Object.keys(body).sort()).toEqual(["id", "messageId"]);
      expect(request.headers()["x-csrf-token"]).toBe("fixture");
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: (options.speechError
          ? [{ type: "error", message: "OpenRouter 额度不足，请检查额度" }]
          : [
              { type: "model", model: status.model },
              { type: "audio", data: pcm.toString("base64") },
              { type: "done" },
            ]
        )
          .map((event) => JSON.stringify(event) + "\n")
          .join(""),
      });
    }
    if (path === "/my-workspace/assistant/voice") data = status;
    if (path === "/my-workspace/assistant/voice/settings") {
      const body = request.postDataJSON();
      writes.push(body);
      status = {
        ...status,
        enabled: body.enabled,
        model: body.model,
        voice: body.voice,
        apiKeyConfigured: !!body.apiKey,
        ready: false,
        verifiedAt: null,
        version: status.version + 1,
      };
      data = status;
    }
    if (path === "/my-workspace/assistant/voice/verify") {
      status = {
        ...status,
        ready: status.enabled,
        verifiedAt: "2026-11-03T00:00:01Z",
      };
      data = { ...status, sample: pcm.subarray(0, 4800).toString("base64") };
    }
    if (path === "/my-workspace/assistant/voice/turn") {
      const body = request.postDataJSON();
      turns.push(body);
      if (options.missed && turns.length === 1)
        return route.fulfill({
          contentType: "application/x-ndjson",
          body: '{"type":"retry-listening"}\n',
        });
      expect(request.headers()["x-csrf-token"]).toBe("fixture");
      const wav = Buffer.from(body.audio, "base64");
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(24000);
      expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
      const reply =
        options.reply || "已整理选款会草稿，请在互动对话核对后确认。";
      assistant.messages.push(
        { id: body.id + "u", role: "user", text: "安排明天下午三点选款会" },
        { id: body.id + "a", role: "assistant", text: reply },
      );
      assistant.version++;
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: [
          { type: "transcript", text: "安排明天下午三点选款会" },
          { type: "reply", text: reply, messageId: body.id + "a" },
          ...(options.navigation
            ? [{ type: "navigate", toolId: "analytics" }]
            : []),
          { type: "model", model: "openai/gpt-audio" },
          { type: "audio", data: pcm.toString("base64") },
          { type: "done" },
        ]
          .map((x) => JSON.stringify(x) + "\n")
          .join(""),
      });
    }
    await route.fulfill({ json: { data } });
  });
  const ready = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/v1/my-workspace/assistant/voice",
  );
  await page.goto("/my-workspace");
  await ready;
  await expect(page.locator(".companion-launch")).toBeVisible();
  return {
    bubble: page.getByRole("region", { name: "小序语音", exact: true }),
    turns,
    writes,
    speeches,
  };
}

async function expectWorkspaceCaptionsAtTop(page: Page) {
  const captions = page.locator(
    ".workspace-voice-slot .companion-voice-inline",
  );
  await expect(captions).toBeVisible();
  await expect(page.locator(".companion-voice-bubble")).toHaveCount(0);
  await expect
    .poll(async () => {
      const root = await page
        .getByRole("region", { name: "工作台三维场景", exact: true })
        .boundingBox();
      const box = await captions.boundingBox();
      return (
        !!root &&
        !!box &&
        box.y >= root.y &&
        box.y < root.y + 180 &&
        Math.abs(box.x + box.width / 2 - (root.x + root.width / 2)) <= 2
      );
    })
    .toBe(true);
}

test("未识别完整文字后静默恢复聆听，下一句话可继续且不重启麦克风", async ({
  page,
}) => {
  const { bubble, turns } = await fixture(page, { missed: true });
  await page.locator(".companion-launch").click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await page.waitForTimeout(600);
  await page.evaluate(() => window.gptVoiceTest.silence());
  await expect.poll(() => turns.length).toBe(1);
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expect(bubble).not.toContainText("重试");
  expect(
    await page.evaluate(() => [
      window.gptVoiceTest.starts,
      window.gptVoiceTest.stops,
    ]),
  ).toEqual([1, 0]);
  await page.evaluate(() => window.gptVoiceTest.speak());
  await page.waitForTimeout(600);
  await page.evaluate(() => window.gptVoiceTest.silence());
  await expect.poll(() => turns.length).toBe(2);
  await expect(bubble.getByRole("status")).toHaveText("小序正在说话");
  await bubble.getByRole("button", { name: "查看完整对话" }).click();
});

test("文字回复用 GPT 声音朗读和自动回答，不开启麦克风，停止与关闭立即中断", async ({
  page,
}) => {
  const { speeches } = await fixture(page, { dark: true });
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  const input = dialog.getByPlaceholder(/告诉我你想完成什么/);
  await input.fill("你好");
  await input.press("Enter");
  await expect(
    dialog.getByRole("button", { name: "小序朗读这条回复" }),
  ).toBeEnabled();
  expect(speeches).toHaveLength(0);
  await dialog.getByRole("button", { name: "小序朗读这条回复" }).click();
  await expect(dialog.getByRole("status")).toContainText("小序正在说话");
  await expect(page.locator(".sidebar-assistant")).toHaveAttribute(
    "data-state",
    "speaking",
  );
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(0);
  await page.screenshot({
    path: test.info().outputPath("chat-gpt-speech-dark.png"),
  });
  await dialog.getByRole("button", { name: "停止小序朗读" }).click();
  await expect(page.locator(".sidebar-assistant")).not.toHaveAttribute(
    "data-state",
    "speaking",
  );
  await setAssistantOption(page, "语音回复", true);
  await input.fill("继续聊聊");
  await input.press("Enter");
  await expect.poll(() => speeches.length).toBe(2);
  await expect(dialog.getByRole("status")).toContainText("小序正在说话");
  await setAssistantOption(page, "语音回复", false);
  await expect(page.locator(".sidebar-assistant")).not.toHaveAttribute(
    "data-state",
    "speaking",
  );
  await dialog.getByRole("button", { name: "小序朗读这条回复" }).last().click();
  await expect.poll(() => speeches.length).toBe(3);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".sidebar-assistant")).not.toHaveAttribute(
    "data-state",
    "speaking",
  );
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(0);
});

test("GPT 朗读失败保留文字及具体错误，不启动录音", async ({ page }) => {
  await fixture(page, { speechError: true });
  await openPersonalAssistant(page);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await dialog.getByPlaceholder(/告诉我你想完成什么/).fill("你好");
  await dialog.getByPlaceholder(/告诉我你想完成什么/).press("Enter");
  await dialog.getByRole("button", { name: "小序朗读这条回复" }).click();
  await expect(dialog.getByRole("alert")).toContainText("智能服务 额度不足");
  await expect(
    dialog.getByText("你好，我是小序。今天有什么想一起完成的？", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(0);
});

test("授权语音导航事件直接打开经营分析", async ({ page }) => {
  const { turns } = await fixture(page, { navigation: true });
  await page.locator(".companion-launch").click();
  await page.waitForTimeout(700);
  await page.evaluate(() => window.gptVoiceTest.silence());
  await expect.poll(() => turns.length).toBe(1);
  await expect(page).toHaveURL(/analytics\/compass$/);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
});

test("直接点击小序录音，顶部字幕和动作同步，播放可打断并关闭设备", async ({
  page,
}) => {
  const { bubble, turns } = await fixture(page);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(0);
  await page.locator(".companion-launch").click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expectWorkspaceCaptionsAtTop(page);
  const captions = page.locator(
    ".companion-voice-inline[data-caption-presence]",
  );
  await expect(captions).toHaveAttribute("data-caption-presence", "open");
  const lifecycle = await captions.evaluateHandle((element) => {
    const record = { reentered: false, exited: false, exitInert: false };
    const observer = new MutationObserver(() => {
      const phase = element.getAttribute("data-caption-presence");
      if (phase === "entering") record.reentered = true;
      if (phase === "exiting") {
        record.exited = true;
        record.exitInert =
          element.hasAttribute("inert") &&
          element.getAttribute("aria-hidden") === "true";
      }
    });
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["data-caption-presence"],
    });
    return record;
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".realtime-orb")).toHaveCount(0);
  await expect(page.locator(".sidebar-assistant")).toHaveAttribute(
    "data-state",
    "listening",
  );
  await page.waitForTimeout(600);
  await page.evaluate(() => window.gptVoiceTest.silence());
  await expect.poll(() => turns.length).toBe(1);
  expect(turns[0]).toMatchObject({
    includePersonalContext: false,
    includeMemory: false,
  });
  await expect(bubble.getByRole("status")).toHaveText("小序正在说话");
  await expect(page.locator(".sidebar-assistant")).toHaveAttribute(
    "data-state",
    "speaking",
  );
  await expect(page.locator(".companion-speaking-mouth")).toHaveCSS(
    "animation-name",
    "companion-talk-mouth",
  );
  await expect(bubble).toContainText("已整理选款会草稿");
  await page.locator(".companion-launch").click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await bubble.getByRole("button", { name: "麦克风静音", exact: true }).click();
  await expect(bubble.getByRole("status")).toHaveText("麦克风已静音");
  expect((await lifecycle.jsonValue()).reentered).toBe(false);
  await bubble.getByRole("button", { name: "查看完整对话" }).click();
  await expect
    .poll(() => page.evaluate(() => window.gptVoiceTest.stops))
    .toBe(1);
  await expect(bubble).toHaveCount(0);
  await expect(captions).toHaveCount(0);
  expect(await lifecycle.jsonValue()).toEqual({
    reentered: false,
    exited: true,
    exitInert: true,
  });
  await lifecycle.dispose();
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(
    dialog.getByText("已整理选款会草稿，请在互动对话核对后确认。", {
      exact: true,
    }),
  ).toBeVisible();
});

test("减少动态效果下语音字幕静态开关，立即停录且再次主动开启可用", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { bubble, turns } = await fixture(page);
  const captions = page.locator(
    ".companion-voice-inline[data-caption-presence]",
  );
  const start = page.getByRole("button", {
    name: "开始与小序语音对话",
    exact: true,
  });
  await expect(start).toBeVisible();
  await expect(bubble).toHaveCount(0);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(0);
  await start.click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expect(captions).toHaveAttribute("data-caption-presence", "open");
  await expect
    .poll(() =>
      captions.evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === "running").length,
      ),
    )
    .toBe(0);
  await bubble.getByRole("button", { name: "结束语音", exact: true }).click();
  await expect(captions).toHaveCount(0);
  expect(await page.evaluate(() => window.gptVoiceTest.stops)).toBe(1);
  await expect(start).toBeVisible();
  await start.click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expect(captions).toHaveAttribute("data-caption-presence", "open");
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(2);
  expect(turns).toEqual([]);
  await bubble.getByRole("button", { name: "结束语音", exact: true }).click();
  await expect(captions).toHaveCount(0);
  expect(await page.evaluate(() => window.gptVoiceTest.stops)).toBe(2);
});

test("顶部语音字幕在漫游与相机变化时固定，跨页恢复气泡且不中断录音", async ({
  page,
}) => {
  const { bubble, turns } = await fixture(page);
  const companion = page.locator(".workspace-companion");
  const expectBubbleInViewport = async () => {
    const viewport = page.viewportSize()!;
    await expect
      .poll(async () => {
        const rect = await bubble.boundingBox();
        return (
          !!rect &&
          rect.x >= 7 &&
          rect.y >= 7 &&
          rect.x + rect.width <= viewport.width - 7 &&
          rect.y + rect.height <= viewport.height - 7
        );
      })
      .toBe(true);
  };
  await expect(companion).toHaveAttribute("data-docked", "true");
  await companion
    .getByRole("button", { name: "与小序语音对话", exact: true })
    .click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expect(companion).toHaveAttribute("data-docked", "false");
  await expect(companion).toHaveAttribute("data-motion", "idle");
  await expect(page.locator(".workspace-ai")).toHaveAttribute(
    "data-core-state",
    "listening",
  );
  const assistantElement = await companion
    .locator(".sidebar-assistant")
    .elementHandle();
  await expectBubbleInViewport();
  await expectWorkspaceCaptionsAtTop(page);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  await page.getByRole("button", { name: "召唤小序", exact: true }).click();
  await expect(companion).toHaveAttribute("data-docked", "true");
  await expect(companion).toHaveAttribute("data-motion", "idle");
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expectBubbleInViewport();
  const world = page.getByRole("region", {
    name: "工作台三维场景",
    exact: true,
  });
  const beforeCamera = (await bubble.boundingBox())!;
  for (let step = 0; step < 3; step++) await world.press("Shift+ArrowLeft");
  for (let step = 0; step < 3; step++) await world.press("ArrowRight");
  await expect(world).toHaveAttribute("data-world-x", "-120");
  await expect(world).toHaveAttribute("data-world-yaw", "12");
  await expect
    .poll(async () => {
      const moved = (await bubble.boundingBox())!;
      return Math.hypot(moved.x - beforeCamera.x, moved.y - beforeCamera.y);
    })
    .toBeLessThanOrEqual(1);
  await expectBubbleInViewport();
  await expectWorkspaceCaptionsAtTop(page);
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  expect(await page.evaluate(() => window.gptVoiceTest.stops)).toBe(0);
  await page.getByRole("button", { name: "回到中心", exact: true }).click();
  await expect(world).toHaveAttribute("data-world-x", "0");
  await expect(world).toHaveAttribute("data-world-yaw", "0");
  await companion.locator(".companion-launch").press("ArrowRight");
  await expect(companion).toHaveAttribute("data-docked", "false");
  await expect(companion).toHaveAttribute("data-motion", "idle");
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expectBubbleInViewport();
  await expectWorkspaceCaptionsAtTop(page);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  expect(await page.evaluate(() => window.gptVoiceTest.stops)).toBe(0);
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  await expect(page).toHaveURL(/operations$/);
  await expect(bubble).toHaveClass(/companion-voice-bubble/);
  await expect(page.locator(".companion-voice-inline")).toHaveCount(0);
  await expect(companion).toHaveAttribute("data-docked", "false");
  expect(
    await assistantElement!.evaluate((element) => element.isConnected),
  ).toBe(true);
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expectBubbleInViewport();
  const anchor = page.locator(".companion-launch"),
    box = (await anchor.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(1500, 840, { steps: 10 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  expect(await page.evaluate(() => window.gptVoiceTest.stops)).toBe(0);
  await expectBubbleInViewport();
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "我的工作台", exact: true })
    .click();
  await expect(page).toHaveURL(/my-workspace$/);
  await expect(companion).toHaveAttribute("data-docked", "true");
  await expect(companion).toHaveCount(1);
  await expect(page.locator(".sidebar-assistant")).toHaveCount(1);
  expect(
    await assistantElement!.evaluate((element) => element.isConnected),
  ).toBe(true);
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expect(page.locator(".workspace-ai")).toHaveAttribute(
    "data-core-state",
    "listening",
  );
  await expectBubbleInViewport();
  await expectWorkspaceCaptionsAtTop(page);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  expect(await page.evaluate(() => window.gptVoiceTest.stops)).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectBubbleInViewport();
  await expectWorkspaceCaptionsAtTop(page);
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  await page.getByRole("button", { name: "打开日程", exact: true }).click();
  await page.getByRole("button", { name: "新增日程", exact: true }).click();
  const scheduleDialog = page.getByRole("dialog", {
    name: "新增日程",
    exact: true,
  });
  await expect(scheduleDialog).toBeVisible();
  await expect
    .poll(() =>
      scheduleDialog.evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .every((animation) => animation.playState !== "running"),
      ),
    )
    .toBe(true);
  const endVoice = bubble.getByRole("button", {
    name: "结束语音",
    exact: true,
  });
  const closeSchedule = scheduleDialog.getByRole("button", {
    name: "关闭",
    exact: true,
  });
  for (const control of [endVoice, closeSchedule]) {
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
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  expect(await page.evaluate(() => window.gptVoiceTest.stops)).toBe(0);
  await page.screenshot({
    path: ".local/companion-voice-over-modal-mobile.png",
  });
  await closeSchedule.click();
  await expect(scheduleDialog).toBeHidden();
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  expect(await page.evaluate(() => window.gptVoiceTest.stops)).toBe(0);
  await page.getByRole("button", { name: "新增日程", exact: true }).click();
  await expect(scheduleDialog).toBeVisible();
  await endVoice.click();
  await expect
    .poll(() => page.evaluate(() => window.gptVoiceTest.stops))
    .toBe(1);
  await expect(bubble).toHaveCount(0);
  expect(turns).toHaveLength(0);
});

test("麦克风拒绝在顶部字幕说明原因，设置不会开启麦克风", async ({ page }) => {
  const { bubble, turns } = await fixture(page, { denied: true });
  await page.locator(".companion-launch").click();
  await expect(bubble.getByText(/麦克风权限未获允许/)).toBeVisible();
  await expectWorkspaceCaptionsAtTop(page);
  await expect(bubble.getByRole("button", { name: "重试语音" })).toBeEnabled();
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  await bubble.getByRole("button", { name: "重试语音" }).click();
  await expect(bubble.getByText(/麦克风权限未获允许/)).toBeVisible();
  await bubble.getByRole("button", { name: "语音设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(2);
  expect(turns).toHaveLength(0);
});

test("未就绪不录音，设置保存不回显，验证后从设置直接回到小序", async ({
  page,
}) => {
  const { bubble, writes } = await fixture(page, { configured: false });
  await page.locator(".companion-launch").click();
  await expect(
    bubble.getByRole("button", { name: "开始语音对话" }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(0);
  await bubble.getByRole("button", { name: "语音设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("switch", { name: "启用 GPT 语音" }).click();
  await dialog
    .getByLabel("OpenRouter API Key", { exact: true })
    .fill("sk-or-test-only-never-real-secret");
  await dialog.getByRole("button", { name: "保存语音设置" }).click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(
    dialog.getByLabel("OpenRouter API Key", { exact: true }),
  ).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: "与小序语音对话" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "验证并试听" }).click();
  await expect(
    dialog.getByRole("button", { name: "与小序语音对话" }),
  ).toBeEnabled();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "sk-or",
  );
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(0);
  await dialog.getByRole("button", { name: "与小序语音对话" }).click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expect(dialog).not.toBeVisible();
  await bubble.getByRole("button", { name: "结束语音", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => window.gptVoiceTest.stops))
    .toBe(1);
});

test("工作台顶部语音固定暗色，没有遮罩且页面仍能操作", async ({
  page,
}, testInfo) => {
  // A saved light preference still leaves the primary workbench dark.
  const { bubble } = await fixture(page, { dark: false });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: /切换为[亮暗]色主题/ }),
  ).toHaveCount(0);
  await page.locator(".companion-launch").click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expectWorkspaceCaptionsAtTop(page);
  await expect(page.locator(".ant-drawer-mask")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("companion-voice-dark.png"),
  });
  await page.getByRole("button", { name: "放大场景", exact: true }).click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expect(page.locator(".personal-workspace")).toHaveAttribute(
    "data-world-zoom",
    "1.15",
  );
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await bubble.getByRole("button", { name: "结束语音", exact: true }).click();
});

test("刷新不自动重启麦克风，再次主动对话仍使用顶部字幕", async ({ page }) => {
  const { bubble, turns } = await fixture(page);
  await page.locator(".companion-launch").click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expectWorkspaceCaptionsAtTop(page);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  await page.reload();
  await expect(page.locator(".companion-launch")).toBeVisible();
  await expect(bubble).toHaveCount(0);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(0);
  await page.locator(".companion-launch").click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expectWorkspaceCaptionsAtTop(page);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  await bubble.getByRole("button", { name: "结束语音", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.gptVoiceTest.stops))
    .toBe(1);
  expect(turns).toHaveLength(0);
});

test("窄屏长语音字幕不遮挡日期与场景工具，滚动全文不改变场景视角", async ({
  page,
}) => {
  const reply =
    "这是一段需要核对的较长语音回复，请确认日期、时间与商品编码。".repeat(15);
  const { bubble } = await fixture(page, { dark: true, reply });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.locator(".sidebar")).toBeHidden();
  await page.locator(".companion-launch").click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await page.waitForTimeout(250);
  await bubble.getByRole("button", { name: "发送这段", exact: true }).click();
  const caption = bubble.locator(".companion-voice-caption");
  await expect(caption).toContainText(reply);
  const world = page.getByRole("region", {
    name: "工作台三维场景",
    exact: true,
  });
  const camera = () =>
    world.evaluate((element) =>
      ["pitch", "yaw", "x", "y", "zoom"].map((key) =>
        element.getAttribute(`data-world-${key}`),
      ),
    );
  const initial = await camera();
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await expectWorkspaceCaptionsAtTop(page);
    await expect
      .poll(async () => {
        const box = (await bubble.boundingBox())!;
        const controls = (await page
          .locator(".workspace-world-controls")
          .boundingBox())!;
        const date = (await page.locator(".workspace-date").boundingBox())!;
        return [controls, date].every(
          (other) =>
            box.x + box.width <= other.x ||
            other.x + other.width <= box.x ||
            box.y + box.height <= other.y ||
            other.y + other.height <= box.y,
        );
      })
      .toBe(true);
    expect(
      await caption.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    await caption.hover();
    await page.mouse.wheel(0, 200);
    await expect
      .poll(() => caption.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await camera()).toEqual(initial);
    await caption.press("Home");
    await expect
      .poll(() => caption.evaluate((element) => element.scrollTop))
      .toBe(0);
    await caption.press("End");
    await expect
      .poll(() => caption.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await camera()).toEqual(initial);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width + 1);
  }
  await page.screenshot({
    path: ".local/workspace-voice-top-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "全息影像屏", exact: true }).click();
  const hologram = page.getByRole("dialog", {
    name: "全息影像屏",
    exact: true,
  });
  await expect(hologram).toBeVisible();
  await expect(
    bubble.getByRole("button", { name: "结束语音", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: ".local/workspace-hologram-voice-mobile.png",
    fullPage: true,
  });
  await bubble.getByRole("button", { name: "结束语音", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.gptVoiceTest.stops))
    .toBe(1);
  await hologram
    .getByRole("button", { name: "关闭全息影像屏", exact: true })
    .click();
});
