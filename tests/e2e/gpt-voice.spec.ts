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
      const reply = "已整理选款会草稿，请在互动对话核对后确认。";
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
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
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
  await dialog.getByRole("checkbox", { name: "语音回复", exact: true }).check();
  await input.fill("继续聊聊");
  await input.press("Enter");
  await expect.poll(() => speeches.length).toBe(2);
  await expect(dialog.getByRole("status")).toContainText("小序正在说话");
  await dialog
    .getByRole("checkbox", { name: "语音回复", exact: true })
    .uncheck();
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
  await page.getByRole("button", { name: "打开个人助理", exact: true }).click();
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

test("直接点击小序录音，气泡回复和动作同步，播放可打断并关闭设备", async ({
  page,
}) => {
  const { bubble, turns } = await fixture(page);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(0);
  await page.locator(".companion-launch").click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
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
  await bubble.getByRole("button", { name: "查看完整对话" }).click();
  await expect
    .poll(() => page.evaluate(() => window.gptVoiceTest.stops))
    .toBe(1);
  await expect(bubble).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: /AI 个人助理/ });
  await expect(
    dialog.getByText("已整理选款会草稿，请在互动对话核对后确认。", {
      exact: true,
    }),
  ).toBeVisible();
});

test("语音可跨业务页，拖动不重启录音，气泡保持在窗口内，结束释放麦克风", async ({
  page,
}) => {
  const { bubble, turns } = await fixture(page);
  await page.getByRole("button", { name: "智能语音", exact: true }).click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await page
    .locator(".sidebar")
    .getByRole("link", { name: "运营中心", exact: true })
    .click();
  await expect(page).toHaveURL(/operations$/);
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  const anchor = page.locator(".companion-launch"),
    box = (await anchor.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(1500, 840, { steps: 10 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const r = (await bubble.boundingBox())!;
      return (
        r.x >= 7 && r.y >= 7 && r.x + r.width <= 383 && r.y + r.height <= 837
      );
    })
    .toBe(true);
  await bubble.getByRole("button", { name: "结束语音", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.gptVoiceTest.stops))
    .toBe(1);
  await expect(bubble).toHaveCount(0);
  expect(turns).toHaveLength(0);
});

test("麦克风拒绝在小序旁说明原因，设置不会开启麦克风", async ({ page }) => {
  const { bubble, turns } = await fixture(page, { denied: true });
  await page.locator(".companion-launch").click();
  await expect(bubble.getByText(/麦克风权限未获允许/)).toBeVisible();
  await expect(
    bubble.getByRole("button", { name: "开始语音对话" }),
  ).toBeEnabled();
  await bubble.getByRole("button", { name: "语音设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
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

test("小序语音气泡适配明暗主题，没有遮罩且页面仍能操作", async ({
  page,
}, testInfo) => {
  const { bubble } = await fixture(page, { dark: true });
  await page.locator(".companion-launch").click();
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await expect(page.locator(".ant-drawer-mask")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("companion-voice-dark.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "切换为亮色主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(bubble.getByRole("status")).toHaveText("我在听，你说");
  await page.screenshot({
    path: testInfo.outputPath("companion-voice-light.png"),
    animations: "disabled",
  });
  await bubble.getByRole("button", { name: "结束语音", exact: true }).click();
});
