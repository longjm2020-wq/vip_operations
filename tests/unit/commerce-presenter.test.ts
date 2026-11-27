import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  commercePresenterOptions,
  readCommercePresenterVideo,
  removeCommercePresenter,
  saveCommercePresenter,
  startCommercePresenterVideo,
} from "../../apps/api/src/modules/aigc/commerce-presenter.js";
import { createStudio } from "../../packages/aigc-engine/index.mjs";
import { advanceCommerceSpeech } from "../../apps/api/src/modules/workspace/agentai-audio.js";

vi.mock("../../apps/api/src/modules/workspace/agentai-audio.js", () => ({
  commerceClonedVoices: async (actor: { id: string }) =>
    actor.id === "1" ? [{ id: "personal-voice", name: "我的音色" }] : [],
  advanceCommerceSpeech: vi.fn(async () => ({
    task: { status: "processing", errorNote: "" },
  })),
}));

it("binds authorized avatars and saves one private presenter export per request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "commerce-presenter-"));
  const owner = {
    id: "1",
    username: "owner",
    displayName: "Owner",
    role: "super_admin",
    permissions: ["aigc.use", "aigc.manage"],
  };
  const guest = {
    id: "2",
    username: "guest",
    displayName: "Guest",
    role: "operator",
    permissions: ["aigc.use"],
  };
  const engine = await createStudio({
    config: {
      dataDir: dir,
      videoSecrets: {},
      opentalkingBaseUrl: "https://digital.example",
    },
    users: [owner, guest],
    persistence: {
      readState: async () => {
        throw Object.assign(Error("new"), { code: "ENOENT" });
      },
      writeState: async () => {},
      hydrate: async () => {},
    },
  });
  const digital = engine.digitalHuman;
  const upstream = {
    catalog: async () => ({
      models: {
        models: ["quicktalk"],
        statuses: [{ id: "quicktalk", connected: true, backend: "local" }],
      },
      avatars: [{ id: "shared-avatar", name: "形象", model_type: "quicktalk" }],
    }),
    createVideo: vi.fn(async () => ({ job_id: "provider-video" })),
    job: async () => ({
      status: "completed",
      final_export_id: "export",
      generated_duration_ms: 8900,
    }),
    video: vi.fn(async () => ({
      buffer: Buffer.from("provider video fixture"),
      mime: "video/mp4",
    })),
  };
  digital.clientFactory = () => upstream;
  try {
    expect((await commercePresenterOptions(engine, owner)).available).toBe(
      false,
    );
    const checked = await digital.preflight(owner);
    await digital.saveSettings(owner, {
      enabled: true,
      publicEnabled: true,
      textEnabled: true,
      templates: checked.templates,
      voices: [{ id: "studio-configured-voice", label: "系统女声" }],
      sessionMinutes: 5,
      maxTextLength: 1500,
      videoCredits: 0,
      sessionCredits: 0,
    });

    const input = {
      name: "我的主播",
      avatarId: "shared-avatar",
      voiceId: "default:voice:studio-configured-voice",
    };
    await expect(saveCommercePresenter(engine, owner, input)).rejects.toThrow();
    await expect(
      saveCommercePresenter(engine, guest, {
        ...input,
        voiceId: "cloned:personal-voice",
        authorized: true,
      }),
    ).rejects.toThrow();
    const presenter = await saveCommercePresenter(engine, owner, {
      ...input,
      authorized: true,
    });
    expect(
      await saveCommercePresenter(engine, owner, {
        ...input,
        authorized: true,
      }),
    ).toEqual(presenter);
    expect((await commercePresenterOptions(engine, guest)).presenters).toEqual(
      [],
    );

    const run = {
      runId: randomUUID(),
      presenterId: presenter.id,
      text: "版型介绍。",
    };
    await expect(
      startCommercePresenterVideo(engine, guest, run),
    ).rejects.toThrow();
    const [first, repeated] = await Promise.all([
      startCommercePresenterVideo(engine, owner, run),
      startCommercePresenterVideo(engine, owner, run),
    ]);
    expect(repeated.operationId).toEqual(first.operationId);
    expect(upstream.createVideo).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        avatarId: "shared-avatar",
        text: run.text,
        voice: "studio-configured-voice",
      }),
    );
    expect(
      await startCommercePresenterVideo(engine, owner, {
        ...run,
        runId: randomUUID(),
      }),
    ).toMatchObject({ status: "awaiting_presenter", operationId: null });
    await digital.tick();
    await digital.tick();
    expect(upstream.video).toHaveBeenCalledTimes(1);
    await expect(
      readCommercePresenterVideo(engine, guest, first.operationId!),
    ).rejects.toThrow();
    expect(
      await readCommercePresenterVideo(engine, owner, first.operationId!),
    ).toMatchObject({
      status: "completed",
      content: Buffer.from("provider video fixture"),
      duration: 8.9,
    });
    expect(digital.projects(owner)).toEqual([]);
    expect(engine.store.getAppState(owner.id).works).toEqual([]);

    const clone = await saveCommercePresenter(engine, owner, {
      ...input,
      voiceId: "cloned:personal-voice",
      authorized: true,
    });
    const cloneRun = {
      ...run,
      runId: randomUUID(),
      presenterId: clone.id,
      maxSpeechCny: 1,
    };
    expect(
      await startCommercePresenterVideo(engine, owner, cloneRun),
    ).toMatchObject({ status: "awaiting_audio", operationId: null });
    expect(
      await startCommercePresenterVideo(engine, owner, cloneRun),
    ).toMatchObject({ status: "awaiting_audio", operationId: null });
    const calls = vi.mocked(advanceCommerceSpeech).mock.calls;
    expect(calls[0][1]).toEqual(calls[1][1]);
    expect(calls[0][1]).toMatchObject({
      text: cloneRun.text,
      voiceId: "personal-voice",
      maxCny: 1,
    });
    expect(upstream.createVideo).toHaveBeenCalledTimes(1);

    await expect(
      removeCommercePresenter(engine, guest, presenter.id),
    ).rejects.toThrow();
    await removeCommercePresenter(engine, owner, presenter.id);
    await expect(
      startCommercePresenterVideo(engine, owner, {
        ...run,
        runId: randomUUID(),
      }),
    ).rejects.toThrow();
  } finally {
    engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
