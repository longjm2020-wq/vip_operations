import { expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createStudio } from "../../packages/aigc-engine/index.mjs";

it("internal digital workflow verifies models, persists output once and supports owned real-time sessions without wallets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aigc-digital-test-"));
  let snapshot: any;
  const owner = {
    id: "1",
    username: "creator",
    role: "super_admin",
    displayName: "Creator",
  };
  const other = { ...owner, id: "2", username: "other", role: "operator" };
  const engine = await createStudio({
    config: {
      dataDir: dir,
      videoSecrets: {},
      opentalkingBaseUrl: "https://inference.test",
      opentalkingApiKey: "fixture-private-key",
    },
    users: [owner, other],
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
  });
  const digital = engine.digitalHuman;
  let finished = false;
  const upstream = {
    catalog: vi.fn(async () => ({
      models: {
        models: ["quicktalk", "mock"],
        statuses: [
          { id: "quicktalk", connected: true, backend: "local" },
          { id: "mock", connected: true, backend: "mock" },
        ],
      },
      avatars: [
        { id: "demo", name: "人物", model_type: "quicktalk" },
        { id: "private", is_custom: true, model_type: "quicktalk" },
        { id: "fake", model_type: "mock" },
      ],
    })),
    createVideo: vi.fn(async () => ({ job_id: "remote_video_1" })),
    job: vi.fn(async () => ({
      status: finished ? "completed" : "generating",
      final_export_id: "export_1",
      generated_duration_ms: 2500,
    })),
    video: vi.fn(async () => ({
      buffer: Buffer.from("fixture-video-bytes"),
      mime: "video/mp4",
    })),
    createSession: vi.fn(async () => ({ session_id: "remote_session_1" })),
    session: vi.fn(async (_id: string, suffix: string) =>
      suffix === "/webrtc/offer"
        ? { type: "answer", sdp: "v=0\r\nfixture" }
        : { status: "ready" },
    ),
    ice: vi.fn(async () => ({ iceServers: [] })),
  };
  digital.clientFactory = () => upstream;
  try {
    expect(digital.catalog(owner).enabled).toBe(false);
    const checked = await digital.preflight(owner);
    expect(checked.templates.map((t: any) => t.id)).toEqual(["demo"]);
    const settings = {
      enabled: true,
      publicEnabled: true,
      realtimeEnabled: true,
      textEnabled: true,
      templates: checked.templates,
      sessionMinutes: 5,
      maxTextLength: 1500,
      videoCredits: 0,
      sessionCredits: 0,
    };
    await expect(digital.saveSettings(other, settings)).rejects.toThrow(/权限/);
    await digital.saveSettings(owner, settings);
    expect(JSON.stringify(digital.admin(owner))).not.toContain(
      "fixture-private-key",
    );
    const project = await digital.saveProject(owner, {
      name: "口播测试",
      avatarId: "demo",
      text: "已确认的商品介绍",
    });
    const requestId = randomUUID();
    const [first, duplicate] = await Promise.all([
      digital.createVideo(owner, project.id, { requestId }),
      digital.createVideo(owner, project.id, { requestId }),
    ]);
    expect(first.id).toBe(duplicate.id);
    expect(upstream.createVideo).toHaveBeenCalledTimes(1);
    expect(snapshot.digitalHuman.operations[first.id].remoteId).toBe(
      "remote_video_1",
    );
    // Changing ordinary configuration must remain possible once a video exists.
    await digital.saveSettings(owner, { ...settings, maxTextLength: 1600 });
    finished = true;
    await digital.tick();
    await digital.tick();
    const result = digital.projectDto(digital.project(owner, project.id))
      .operations[0];
    expect(result.status).toBe("completed");
    expect(engine.store.data.assets[result.output].ownerId).toBe(owner.id);
    expect(upstream.video).toHaveBeenCalledTimes(1);
    expect(engine.store.getAppState(owner.id).works[0].category).toBe(
      "digital_human",
    );
    expect(engine.store.getAppState(other.id).works).toEqual([]);
    expect(engine.store.data.platform.wallets).toBeUndefined();
    expect(engine.store.data.platform.orders).toBeUndefined();
    const session = await digital.createSession(owner, project.id, {
      requestId: randomUUID(),
    });
    await digital.tick();
    await expect(digital.liveAction(other, session.id, "ice")).rejects.toThrow(
      /当前账号/,
    );
    expect(await digital.liveAction(owner, session.id, "ice")).toEqual({
      iceServers: [],
      iceTransportPolicy: "all",
    });
    const answer = await digital.liveAction(owner, session.id, "offer", {
      type: "offer",
      sdp: "v=0\r\nfixture",
    });
    expect(answer.type).toBe("answer");
    await digital.liveAction(owner, session.id, "connected");
    await digital.liveAction(owner, session.id, "speak", {
      text: "你好",
      requestId: randomUUID(),
    });
    await digital.liveAction(owner, session.id, "close");
    expect(digital.data.operations[session.id].status).toBe("closed");
    expect(
      upstream.session.mock.calls.some((call: any) => call[1] === "/speak"),
    ).toBe(true);
    upstream.createVideo.mockRejectedValueOnce(
      new Error("connection lost") as never,
    );
    const uncertain = await digital.createVideo(owner, project.id, {
      requestId: randomUUID(),
    });
    expect(uncertain.status).toBe("uncertain");
    await expect(
      digital.createVideo(owner, project.id, { requestId: randomUUID() }),
    ).rejects.toThrow(/当前数字人任务/);
    await digital.tick();
    expect(upstream.createVideo).toHaveBeenCalledTimes(2);
  } finally {
    engine.stop();
  }
});
