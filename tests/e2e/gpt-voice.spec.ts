import {
  openPersonalAssistant,
  setAssistantOption,
} from "./assistant-controls.js";
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import type { RealtimeStatus } from "../../packages/contracts/src/assistant-realtime.js";
import type {
  PageObservation,
  PageActionResult,
} from "../../packages/contracts/src/assistant-page.js";

declare global {
  interface Window {
    gptVoiceTest: {
      starts: number;
      stops: number;
      silence: () => void;
      speak: () => void;
      audioTrack?: MediaStreamTrack;
    };
    qwenRTCTest: {
      answer: (sdp: string) => Promise<string>;
      send: (event: Record<string, unknown>) => void;
      acknowledge: () => void;
      events: Record<string, unknown>[];
      stats: () => Promise<{ bytes: number; rms: number; state: string }>;
      close: () => void;
    };
  }
}

// The service is mocked, but both WebRTC peers, ICE, DTLS and RTP are real.
// No browser media transport is replaced by a fake implementation.
async function qwenRtcFixture(page: Page, holdConfiguration = false) {
  await page.addInitScript(
    ({ hold }) => {
      let peer: RTCPeerConnection | undefined;
      let channel: RTCDataChannel | undefined;
      let receiver: AudioContext | undefined;
      let analyser: AnalyserNode | undefined;
      let player: HTMLAudioElement | undefined;
      let followup = 0;
      const events: Record<string, unknown>[] = [];
      const send = (event: Record<string, unknown>) =>
        channel!.send(JSON.stringify(event));
      const acknowledge = () =>
        send({
          type: "session.updated",
          session: {
            id: "qwen-fixture",
            model: "qwen3.8-omni-flash-realtime",
            audio: { output: { voice: "Tina" } },
          },
        });
      window.qwenRTCTest = {
        events,
        send,
        acknowledge,
        close: () => {
          player?.pause();
          peer?.close();
          void receiver?.close();
        },
        stats: async () => {
          let bytes = 0;
          for (const value of (await peer!.getStats()).values()) {
            if (value.type === "inbound-rtp" && value.kind === "audio") {
              bytes += value.bytesReceived || 0;
            }
          }
          // Chromium can report totalAudioEnergy=0 even while decoding audio.
          // Measure the actual received waveform to prove signal and silence.
          const samples = new Float32Array(2048);
          analyser?.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(
            samples.reduce((sum, value) => sum + value * value, 0) /
              samples.length,
          );
          return { bytes, rms, state: peer!.connectionState };
        },
        answer: async (sdp) => {
          peer = new RTCPeerConnection({ iceServers: [] });
          peer.ontrack = ({ track }) => {
            // Start the native RTP decoder, keeping its output inaudible.
            player = new Audio();
            player.volume = 0.000001;
            player.srcObject = new MediaStream([track]);
            void player.play();
            receiver = new AudioContext();
            const source = receiver.createMediaStreamSource(
              new MediaStream([track]),
            );
            analyser = receiver.createAnalyser();
            source.connect(analyser);
            const silentOutput = receiver.createGain();
            silentOutput.gain.value = 0.000001;
            analyser.connect(silentOutput);
            silentOutput.connect(receiver.destination);
            void receiver.resume();
          };
          peer.ondatachannel = ({ channel: value }) => {
            channel = value;
            const created = () =>
              send({
                type: "session.created",
                session: {
                  id: "qwen-fixture",
                  model: "qwen3.8-omni-flash-realtime",
                },
              });
            channel.onopen = created;
            if (channel.readyState === "open") created();
            channel.onmessage = ({ data }) => {
              const event = JSON.parse(String(data));
              events.push(event);
              if (event.type === "session.update" && !hold) acknowledge();
              if (event.type === "response.create") {
                const id = `followup-${++followup}`;
                send({ type: "response.created", response: { id } });
                send({
                  type: "response.done",
                  response: { id, status: "completed" },
                });
              }
            };
          };
          await peer.setRemoteDescription({ type: "offer", sdp });
          await peer.setLocalDescription(await peer.createAnswer());
          if (peer.iceGatheringState !== "complete")
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => reject(Error("Fixture ICE timed out")),
                5000,
              );
              peer!.addEventListener("icegatheringstatechange", () => {
                if (peer!.iceGatheringState === "complete") {
                  clearTimeout(timer);
                  resolve();
                }
              });
            });
          return peer.localDescription!.sdp;
        },
      };
    },
    { hold: holdConfiguration },
  );
  const starts: Record<string, unknown>[] = [];
  const tools: Record<string, unknown>[] = [];
  const writes: string[] = [];
  await page.route(
    "**/api/v1/my-workspace/assistant/realtime**",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      writes.push(path);
      let data: unknown = {
        provider: "qwen",
        transport: "webrtc",
        enabled: true,
        ready: true,
        voice: "Tina",
        apiKeyConfigured: true,
        encryptionReady: true,
        verifiedAt: "2026-11-07T00:00:00Z",
        error: "",
        canManage: true,
        version: 1,
      };
      if (path.endsWith("/sessions")) {
        const body = route.request().postDataJSON();
        starts.push(body);
        expect(body.sdp).toContain("m=audio");
        expect(body.sdp).toContain("a=candidate:");
        data = {
          provider: "qwen",
          transport: "webrtc",
          pageControl: !body.desktopDeviceId,
          sdp: await page.evaluate(
            (sdp) => window.qwenRTCTest.answer(sdp),
            body.sdp,
          ),
          configuration: {
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              audio: { output: { voice: "Tina" } },
              turn_detection: { type: "semantic_vad_ec" },
              tools: [],
            },
          },
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
      } else if (path.endsWith("/tool")) {
        const body = route.request().postDataJSON();
        tools.push(body);
        data =
          body.callId === "computer"
            ? { text: "电脑任务已创建", desktopTaskId: "task" }
            : {
                text: "正在打开页面",
                navigation: body.callId === "home" ? "workspace" : "analytics",
              };
      } else if (path.endsWith("/close")) data = { closed: true };
      else if (path.includes("/sessions/"))
        data = {
          active: true,
          saved: true,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
      await route.fulfill({ json: { data } });
    },
  );
  return { starts, tools, writes };
}

async function sendQwenTool(
  page: Page,
  callId: string,
  tool: string,
  args: Record<string, unknown> = { request: callId },
  newTurn = true,
  interrupt = false,
) {
  await page.evaluate(
    ({ callId, tool, args, newTurn, interrupt }) => {
      const send = window.qwenRTCTest.send;
      const id = `response-${callId}`;
      if (newTurn) {
        send({
          type: "input_audio_buffer.speech_started",
          item_id: `user-${callId}`,
        });
        send({
          type: "input_audio_buffer.speech_stopped",
          item_id: `user-${callId}`,
        });
      }
      send({ type: "response.created", response: { id } });
      send({
        type: "response.function_call_arguments.done",
        response_id: id,
        name: tool,
        call_id: callId,
        arguments: JSON.stringify(args),
      });
      send({ type: "response.done", response: { id, status: "completed" } });
      if (interrupt) {
        send({
          type: "input_audio_buffer.speech_started",
          item_id: "interrupt-page-action",
        });
        send({
          type: "input_audio_buffer.speech_stopped",
          item_id: "interrupt-page-action",
        });
      }
    },
    { callId, tool, args, newTurn, interrupt },
  );
}

async function qwenToolOutput<T>(page: Page, callId: string): Promise<T> {
  const output = () =>
    page.evaluate((id) => {
      const event = window.qwenRTCTest.events.find((event) => {
        const item = event.item as { call_id?: string } | undefined;
        return (
          event.type === "conversation.item.create" && item?.call_id === id
        );
      });
      return (event?.item as { output?: string } | undefined)?.output;
    }, callId);
  await expect.poll(output).toBeTruthy();
  return JSON.parse((await output())!) as T;
}

test("千问实时语音观察并点击任意新控件，跨业务页继续且打断后不派发旧动作", async ({
  page,
}) => {
  const { bubble } = await fixture(page, { configured: false });
  const { starts, tools } = await qwenRtcFixture(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.reload();
  await page.locator(".companion-launch").click();
  await expect(bubble.getByRole("status")).toHaveText("实时聆听中，你说");
  const arbitrary = `动态按钮-${crypto.randomUUID().slice(0, 8)}`;
  await page.evaluate((name) => {
    const panel = document.createElement("section");
    panel.id = "voice-arbitrary-page";
    panel.style.cssText =
      "position:fixed;top:240px;left:420px;z-index:60;padding:20px;background:#fff;color:#111";
    const button = document.createElement("button");
    button.textContent = name;
    button.onclick = () => {
      panel.dataset.count = String(Number(panel.dataset.count || 0) + 1);
    };
    const link = document.createElement("a");
    link.href = "/analytics/compass";
    link.textContent = "任意业务页面链接";
    panel.append(button, link);
    document.body.append(panel);
  }, arbitrary);
  await sendQwenTool(page, "observe-a", "page_observe", { query: arbitrary });
  const first = await qwenToolOutput<PageObservation>(page, "observe-a");
  const target = first.controls.find((control) => control.name === arbitrary)!;
  expect(target).toBeTruthy();
  await sendQwenTool(
    page,
    "click-a",
    "page_click",
    { snapshotId: first.snapshotId, ref: target.ref },
    false,
  );
  expect(
    (await qwenToolOutput<PageActionResult>(page, "click-a")).dispatched,
  ).toBe(true);
  await expect(page.locator("#voice-arbitrary-page")).toHaveAttribute(
    "data-count",
    "1",
  );
  await sendQwenTool(
    page,
    "observe-legacy",
    "page_observe",
    { query: arbitrary },
    false,
  );
  const legacy = await qwenToolOutput<PageObservation>(page, "observe-legacy");
  await sendQwenTool(
    page,
    "legacy-empty-click",
    "page_action",
    {
      snapshotId: legacy.snapshotId,
      ref: legacy.controls.find((control) => control.name === arbitrary)!.ref,
      action: "click",
      value: "",
      direction: null,
    },
    false,
  );
  const legacyResult = await qwenToolOutput<PageActionResult>(
    page,
    "legacy-empty-click",
  );
  expect(legacyResult.dispatched).toBe(true);
  await expect(page.locator("#voice-arbitrary-page")).toHaveAttribute(
    "data-count",
    "2",
  );
  // Missing required fields must produce a recoverable tool result without
  // dispatching anything or making up a target reference.
  await sendQwenTool(
    page,
    "missing-click-ref",
    "page_click",
    {
      snapshotId: legacyResult.observation.snapshotId,
    },
    false,
  );
  const invalid = await qwenToolOutput<{
    dispatched: boolean;
    code: string;
    text: string;
  }>(page, "missing-click-ref");
  expect(invalid.dispatched).toBe(false);
  expect(invalid.code).toBe("PAGE_TOOL_ARGUMENTS");
  expect(invalid.text).toMatch(/ref|控件|引用/);
  expect(invalid.text).not.toMatch(/invalid_type|ZodError|"issues"|stack/i);
  await expect(page.locator("#voice-arbitrary-page")).toHaveAttribute(
    "data-count",
    "2",
  );
  const recovery = {
    snapshotId: legacyResult.observation.snapshotId,
    ref: legacyResult.observation.controls.find(
      (control) => control.name === arbitrary,
    )!.ref,
  };
  await sendQwenTool(page, "recovered-click", "page_click", recovery, false);
  expect(
    (await qwenToolOutput<PageActionResult>(page, "recovered-click"))
      .dispatched,
  ).toBe(true);
  await expect(page.locator("#voice-arbitrary-page")).toHaveAttribute(
    "data-count",
    "3",
  );
  // A replay of the provider event with the same call ID is never a second click.
  await sendQwenTool(page, "recovered-click", "page_click", recovery, false);
  await sendQwenTool(
    page,
    "observe-link",
    "page_observe",
    { query: "任意业务页面链接" },
    false,
  );
  const link = await qwenToolOutput<PageObservation>(page, "observe-link");
  await expect(page.locator("#voice-arbitrary-page")).toHaveAttribute(
    "data-count",
    "3",
  );
  expect(
    await page.evaluate(
      () =>
        window.qwenRTCTest.events.filter(
          (event) =>
            event.type === "conversation.item.create" &&
            (event.item as { call_id?: string } | undefined)?.call_id ===
              "recovered-click",
        ).length,
    ),
  ).toBe(1);
  await sendQwenTool(
    page,
    "click-link",
    "page_click",
    {
      snapshotId: link.snapshotId,
      ref: link.controls.find((control) => control.name === "任意业务页面链接")!
        .ref,
    },
    false,
  );
  expect(
    (await qwenToolOutput<PageActionResult>(page, "click-link")).dispatched,
  ).toBe(true);
  await expect(page).toHaveURL(/\/analytics\/compass$/);
  const next = `新页面控件-${crypto.randomUUID().slice(0, 8)}`;
  await page.evaluate((name) => {
    const panel = document.querySelector<HTMLElement>("#voice-arbitrary-page")!;
    panel.replaceChildren();
    panel.dataset.count = "0";
    const button = document.createElement("button");
    button.textContent = name;
    button.onclick = () => {
      panel.dataset.count = String(Number(panel.dataset.count || 0) + 1);
    };
    panel.append(button);
  }, next);
  await sendQwenTool(page, "observe-b", "page_observe", { query: next }, false);
  const second = await qwenToolOutput<PageObservation>(page, "observe-b");
  expect(second.path).toContain("/analytics/compass");
  await sendQwenTool(
    page,
    "interrupted-click",
    "page_click",
    {
      snapshotId: second.snapshotId,
      ref: second.controls.find((control) => control.name === next)!.ref,
    },
    false,
    true,
  );
  // A later observation completes after the canceled action's queue position.
  await sendQwenTool(
    page,
    "observe-after-interrupt",
    "page_observe",
    { query: next },
    false,
  );
  const after = await qwenToolOutput<PageObservation>(
    page,
    "observe-after-interrupt",
  );
  await expect(page.locator("#voice-arbitrary-page")).toHaveAttribute(
    "data-count",
    "0",
  );
  await sendQwenTool(
    page,
    "click-b",
    "page_click",
    {
      snapshotId: after.snapshotId,
      ref: after.controls.find((control) => control.name === next)!.ref,
    },
    false,
  );
  expect(
    (await qwenToolOutput<PageActionResult>(page, "click-b")).dispatched,
  ).toBe(true);
  await expect(page.locator("#voice-arbitrary-page")).toHaveAttribute(
    "data-count",
    "1",
  );
  expect(tools).toHaveLength(0);
  expect(starts).toHaveLength(1);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  expect(pageErrors).toEqual([]);
  await bubble.getByRole("button", { name: "结束语音", exact: true }).click();
});

test("千问实时语音绑定所选电脑，刷新电脑任务并在同一通话返回工作台", async ({
  page,
}) => {
  const { bubble } = await fixture(page, { configured: false });
  const deviceId = "55555555-5555-4555-8555-555555555555";
  const { starts, tools } = await qwenRtcFixture(page);
  let desktopReads = 0;
  await page.route(
    "**/api/v1/my-workspace/assistant/desktop",
    async (route) => {
      desktopReads++;
      await route.fulfill({
        json: {
          data: {
            devices: [
              {
                id: deviceId,
                name: "测试电脑",
                online: true,
                crossWindowAuthorized: true,
                lastSeenAt: new Date().toISOString(),
                expiresAt: "2026-12-01T00:00:00Z",
              },
            ],
            tasks: [],
          },
        },
      });
    },
  );
  await page.reload();
  const composer = page.locator(".assistant-compose:visible");
  await composer.getByRole("button", { name: "电脑授权：网站内" }).click();
  await page.getByRole("combobox", { name: "执行位置" }).click();
  await page.getByText("测试电脑", { exact: true }).last().click();
  await composer.getByRole("button", { name: "电脑授权：跨窗口授权" }).click();
  await composer.getByRole("button", { name: "开始智能语音对话" }).click();
  await expect(bubble.getByRole("status")).toHaveText("实时聆听中，你说");
  await expect(bubble.locator(".companion-voice-target")).toHaveText(
    "电脑操作 · 测试电脑",
  );
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ desktopDeviceId: deviceId });
  expect(starts[0]).not.toHaveProperty("authorizationId");
  await page.screenshot({ path: ".local/realtime-desktop-voice.png" });
  const before = desktopReads;
  await sendQwenTool(page, "computer", "desktop_request");
  await expect.poll(() => desktopReads).toBeGreaterThan(before);
  await sendQwenTool(page, "analytics", "workspace_request");
  await expect(page).toHaveURL(/\/analytics\/compass$/);
  await sendQwenTool(page, "home", "workspace_request");
  await expect(page).toHaveURL(/\/my-workspace$/);
  expect(tools).toHaveLength(3);
  expect(starts).toHaveLength(1);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(bubble.locator(".companion-voice-target")).toBeInViewport();
  await page.screenshot({ path: ".local/realtime-desktop-voice-mobile.png" });
  await bubble.getByRole("button", { name: "结束语音", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.gptVoiceTest.stops))
    .toBe(1);
});

test("千问 WebRTC 真实 RTP 在页面卡顿后继续，配置确认后才发送并支持静音清理", async ({
  page,
}) => {
  const { bubble } = await fixture(page, { configured: false });
  const { starts, writes } = await qwenRtcFixture(page, true);
  await page.reload();
  await page.locator(".companion-launch").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.qwenRTCTest.events.filter((e) => e.type === "session.update")
            .length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => window.gptVoiceTest.audioTrack?.enabled),
  ).toBe(false);
  expect((await page.evaluate(() => window.qwenRTCTest.stats())).bytes).toBe(0);
  await page.evaluate(() => window.qwenRTCTest.acknowledge());
  await expect(bubble.getByRole("status")).toHaveText("实时聆听中，你说");
  await expect
    .poll(
      async () => (await page.evaluate(() => window.qwenRTCTest.stats())).bytes,
    )
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () => (await page.evaluate(() => window.qwenRTCTest.stats())).rms,
    )
    .toBeGreaterThan(0.01);
  const before = await page.evaluate(() => window.qwenRTCTest.stats());
  expect(before.state).toBe("connected");
  await page.evaluate(() => {
    const until = performance.now() + 750;
    while (performance.now() < until) {
      /* Simulated rendering stall while native RTP continues. */
    }
  });
  await expect
    .poll(
      async () => (await page.evaluate(() => window.qwenRTCTest.stats())).bytes,
    )
    .toBeGreaterThan(before.bytes + 1000);
  await expect(bubble.getByRole("status")).toHaveText("实时聆听中，你说");
  expect(starts).toHaveLength(1);
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
  await bubble.getByRole("button", { name: "麦克风静音", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.gptVoiceTest.audioTrack?.enabled))
    .toBe(false);
  await expect
    .poll(
      async () => (await page.evaluate(() => window.qwenRTCTest.stats())).rms,
    )
    .toBeLessThan(0.0001);
  await bubble.getByRole("button", { name: "取消静音", exact: true }).click();
  await expect
    .poll(
      async () => (await page.evaluate(() => window.qwenRTCTest.stats())).rms,
    )
    .toBeGreaterThan(0.01);
  expect(
    await page.evaluate(() => window.gptVoiceTest.audioTrack?.enabled),
  ).toBe(true);
  // Qwen WebRTC carries audio over RTP; no PCM append/commit events are sent.
  expect(
    await page.evaluate(() =>
      window.qwenRTCTest.events.filter(
        (e) =>
          e.type === "input_audio_buffer.append" ||
          e.type === "input_audio_buffer.commit",
      ),
    ),
  ).toEqual([]);
  await page.evaluate(() => window.qwenRTCTest.close());
  await expect
    .poll(() => page.evaluate(() => window.gptVoiceTest.stops))
    .toBe(1);
  await expect
    .poll(() => writes.some((path) => path.endsWith("/close")))
    .toBe(true);
});

for (const provider of ["doubao"] as const) {
  test(`${provider} 全双工实时通话用真实音频处理发送短帧，静音恢复与断开释放麦克风`, async ({
    page,
  }) => {
    const { bubble } = await fixture(page, { configured: false });
    let socket: WebSocketRoute | undefined;
    const frames: Record<string, unknown>[] = [];
    const writes: string[] = [];
    await page.route(
      "**/api/v1/my-workspace/assistant/realtime**",
      async (route) => {
        const path = new URL(route.request().url()).pathname;
        writes.push(path);
        let data: unknown = {
          provider,
          transport: "websocket",
          enabled: true,
          ready: true,
          voice: "zh_female_vv_uranus_bigtts",
          apiKeyConfigured: true,
          encryptionReady: true,
          verifiedAt: "2026-11-05T00:00:00Z",
          error: "",
          canManage: true,
          version: 1,
        };
        if (path.endsWith("/sessions")) {
          expect(route.request().postDataJSON()).not.toHaveProperty("sdp");
          data = {
            transport: "websocket",
            ticket: "fixture-one-use-ticket",
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          };
        } else if (path.endsWith("/close")) data = { closed: true };
        else if (path.includes("/sessions/"))
          data = {
            active: true,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          };
        await route.fulfill({ json: { data } });
      },
    );
    await page.routeWebSocket(
      "**/api/v1/my-workspace/assistant/realtime/sessions/*/socket",
      (ws) => {
        socket = ws;
        ws.onMessage((raw) => {
          const event = JSON.parse(raw.toString());
          frames.push(event);
          if (event.type === "authenticate") {
            expect(event.ticket).toBe("fixture-one-use-ticket");
            ws.send(
              JSON.stringify({
                type: "xuti.ready",
                expiresAt: new Date(Date.now() + 3600000).toISOString(),
              }),
            );
          }
          if (event.type === "session.close") ws.close();
        });
      },
    );
    await page.reload();
    await page.locator(".companion-launch").click();
    await expect(bubble.getByRole("status")).toHaveText("实时聆听中，你说");
    await expect
      .poll(
        () =>
          frames.filter((f) => f.type === "input_audio_buffer.append").length,
      )
      .toBeGreaterThan(3);
    for (const frame of frames.filter(
      (f) => f.type === "input_audio_buffer.append",
    ))
      expect(Buffer.from(String(frame.audio), "base64").length).toBe(640);
    // The audio worklet continues recording while navigation/rendering blocks
    // the main thread. Recover that backlog within this same live session.
    const beforeStall = frames.filter(
      (f) => f.type === "input_audio_buffer.append",
    ).length;
    await page.evaluate(() => {
      const until = performance.now() + 750;
      while (performance.now() < until) {
        /* Simulated rendering stall. */
      }
    });
    await expect
      .poll(
        () =>
          frames.filter((f) => f.type === "input_audio_buffer.append").length,
      )
      .toBeGreaterThan(beforeStall + 45);
    await expect(bubble.getByRole("status")).toHaveText("实时聆听中，你说");
    expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(1);
    await bubble
      .getByRole("button", { name: "麦克风静音", exact: true })
      .click();
    await expect
      .poll(() => frames.some((f) => f.type === "input_audio_mute.commit"))
      .toBe(true);
    await bubble.getByRole("button", { name: "取消静音", exact: true }).click();
    await expect
      .poll(() => frames.some((f) => f.type === "input_audio_unmute.commit"))
      .toBe(true);
    socket!.send(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.started",
        item_id: "q1",
      }),
    );
    socket!.send(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "q1",
        transcript: "你好，小序",
      }),
    );
    socket!.send(
      JSON.stringify({
        type: "response.output_text.done",
        question_id: "q1",
        response_id: "r1",
        text: "我在，有什么需要帮忙？",
      }),
    );
    socket!.send(
      JSON.stringify({
        type: "response.output_audio.started",
        question_id: "q1",
        response_id: "r1",
      }),
    );
    socket!.send(
      JSON.stringify({
        type: "response.output_audio.delta",
        question_id: "q1",
        response_id: "r1",
        delta: Buffer.alloc(48000).toString("base64"),
      }),
    );
    await expect(bubble.getByRole("status")).toHaveText("小序正在说话");
    socket!.send(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.started",
        item_id: "q2",
      }),
    );
    await expect(bubble.getByRole("status")).toHaveText("实时聆听中，你说");
    expect(await page.evaluate(() => window.gptVoiceTest.stops)).toBe(0);
    socket!.close();
    await expect
      .poll(() => page.evaluate(() => window.gptVoiceTest.stops))
      .toBe(1);
    await expect
      .poll(() => writes.some((path) => path.endsWith("/close")))
      .toBe(true);
    await expect(bubble).not.toContainText("zh_female");
  });
}

test("实时通道切换分别保留配置，密钥保存后清空且验证不录音", async ({
  page,
}) => {
  const { bubble } = await fixture(page, { configured: false });
  let status: RealtimeStatus = {
    provider: "openai",
    transport: "webrtc",
    enabled: false,
    ready: false,
    voice: "marin",
    apiKeyConfigured: true,
    encryptionReady: true,
    verifiedAt: "2026-11-03T00:00:00Z",
    error: "",
    canManage: true,
    version: 0,
    profiles: {
      openai: {
        voice: "marin",
        apiKeyConfigured: true,
        verifiedAt: "2026-11-03T00:00:00Z",
        error: "",
      },
      doubao: {
        voice: "zh_female_vv_uranus_bigtts",
        apiKeyConfigured: false,
        verifiedAt: null,
        error: "",
      },
      qwen: {
        voice: "Tina",
        apiKeyConfigured: false,
        verifiedAt: null,
        error: "",
        workspaceId: "",
        freeQuotaOnlyConfirmed: false,
      },
    },
  };
  const writes: Record<string, unknown>[] = [];
  await page.route(
    "**/api/v1/my-workspace/assistant/realtime**",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/settings")) {
        const body = route.request().postDataJSON();
        writes.push(body);
        expect(route.request().headers()["x-csrf-token"]).toBe("fixture");
        const provider = body.provider as "openai" | "doubao" | "qwen";
        const prior = status.profiles![provider];
        const profile = {
          ...prior,
          voice: body.voice,
          apiKeyConfigured: !!body.apiKey || prior.apiKeyConfigured,
          verifiedAt: body.apiKey ? null : prior.verifiedAt,
          ...(provider === "qwen"
            ? {
                workspaceId: body.workspaceId,
                freeQuotaOnlyConfirmed: body.freeQuotaOnlyConfirmed,
              }
            : {}),
        };
        status = {
          ...status,
          ...profile,
          provider,
          transport: provider === "doubao" ? "websocket" : "webrtc",
          enabled: body.enabled,
          ready: false,
          version: status.version + 1,
          profiles: { ...status.profiles!, [provider]: profile },
        };
      }
      if (path.endsWith("/verify")) {
        status = {
          ...status,
          ready: status.enabled,
          verifiedAt: "2026-11-05T00:00:00Z",
        };
        status.profiles![status.provider!].verifiedAt = status.verifiedAt;
      }
      await route.fulfill({ json: { data: status } });
    },
  );
  await page.reload();
  await page.locator(".companion-launch").click();
  await bubble.getByRole("button", { name: "语音设置", exact: true }).click();
  const settings = page.locator(".realtime-settings");
  await settings.getByLabel("实时服务通道", { exact: true }).click();
  await page
    .getByText("豆包实时语音（火山引擎）", { exact: true })
    .last()
    .click();
  await expect(
    settings.getByLabel("实时服务密钥", { exact: true }),
  ).toHaveAttribute("placeholder", "输入火山引擎语音服务 API Key");
  await settings.getByRole("switch", { name: "优先使用实时通话" }).click();
  await settings
    .getByLabel("实时服务密钥", { exact: true })
    .fill("doubao-fixture-only-never-real-secret");
  await settings.getByRole("button", { name: "保存实时设置" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    provider: "doubao",
    voice: "zh_female_vv_uranus_bigtts",
    enabled: true,
  });
  await expect(
    settings.getByLabel("实时服务密钥", { exact: true }),
  ).toHaveValue("");
  await settings.getByRole("button", { name: "验证实时通道" }).click();
  await expect(
    settings.getByText("实时通话已就绪", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "doubao-fixture-only",
  );
  await settings.getByLabel("实时服务通道", { exact: true }).click();
  await page.getByText("OpenAI 实时语音", { exact: true }).last().click();
  await expect(
    settings.getByLabel("实时服务密钥", { exact: true }),
  ).toHaveAttribute("placeholder", "已保存，不回显");
  await expect(
    settings.getByRole("button", { name: "验证实时通道" }),
  ).toBeDisabled();
  await settings.getByLabel("实时服务通道", { exact: true }).click();
  await page.getByText("千问实时语音（北京）", { exact: true }).last().click();
  await settings
    .getByLabel("北京地域业务空间 ID", { exact: true })
    .fill("workspace-1");
  await settings
    .getByLabel("实时服务密钥", { exact: true })
    .fill("sk-qwen-fixture-never-real-key");
  await expect(
    settings.getByRole("switch", { name: "优先使用实时通话" }),
  ).toBeDisabled();
  await settings
    .getByRole("checkbox", {
      name: "我已在百炼控制台确认“免费额度用完即停”已生效",
    })
    .check();
  await settings.getByRole("switch", { name: "优先使用实时通话" }).click();
  await settings.getByRole("button", { name: "保存实时设置" }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({
    provider: "qwen",
    voice: "Tina",
    enabled: true,
    workspaceId: "workspace-1",
    freeQuotaOnlyConfirmed: true,
  });
  await expect(
    settings.getByLabel("实时服务密钥", { exact: true }),
  ).toHaveValue("");
  await settings.getByRole("button", { name: "验证实时通道" }).click();
  await expect(
    settings.getByText("实时通话已就绪", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.gptVoiceTest.starts)).toBe(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "qwen-fixture",
  );
  await settings
    .getByLabel("北京地域业务空间 ID", { exact: true })
    .fill("workspace-2");
  await expect(
    settings.getByRole("checkbox", {
      name: "我已在百炼控制台确认“免费额度用完即停”已生效",
    }),
  ).not.toBeChecked();
  await expect(
    settings.getByRole("switch", { name: "优先使用实时通话" }),
  ).not.toBeChecked();
  await expect(
    settings.getByRole("button", { name: "验证实时通道" }),
  ).toBeDisabled();
});

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
          // Preserve the synthetic tone through WebRTC's speech preprocessing.
          track.contentHint = "music";
          window.gptVoiceTest.audioTrack = track;
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
    if (path === "/analytics/compass")
      data = { empty: true, summary: {}, top: [], sources: [] };
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
    if (path === "/my-workspace/assistant/realtime")
      data = {
        enabled: false,
        ready: false,
        voice: "marin",
        canManage: true,
        version: 0,
        encryptionReady: true,
        apiKeyConfigured: false,
        verifiedAt: null,
        error: "",
      };
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
  await dialog.getByText("原有分段语音与朗读设置", { exact: true }).click();
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
