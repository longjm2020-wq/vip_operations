import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    gptVoiceTest: { starts: number; stops: number; silence: () => void };
  }
}

async function fixture(
  page: Page,
  options: { denied?: boolean; configured?: boolean; dark?: boolean } = {},
) {
  await page.addInitScript(
    ({ denied }) => {
      window.gptVoiceTest = { starts: 0, stops: 0, silence: () => {} };
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
    writes: Record<string, unknown>[] = [];
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
    if (path === "/my-workspace/assistant") data = assistant;
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
  };
}

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
  await page.getByRole("button", { name: "GPT 语音", exact: true }).click();
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
