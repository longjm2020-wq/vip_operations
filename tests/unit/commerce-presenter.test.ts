import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { Request } from "express";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import {
  commercePresenterOptions,
  readCommercePresenterVideo,
  removeCommercePresenter,
  saveCommercePresenter,
  startCommercePresenterVideo,
  uploadCommercePresenterPortrait,
} from "../../apps/api/src/modules/aigc/commerce-presenter.js";
import { createStudio } from "../../packages/aigc-engine/index.mjs";
import { advanceCommerceSpeech } from "../../apps/api/src/modules/workspace/agentai-audio.js";
import { advanceBailianCommerceSpeech } from "../../apps/api/src/modules/aigc/bailian-commerce-voice.js";

const bailianVoice = "0a3deb5c-26f2-4ff1-912e-c619fbf9b616";
vi.mock("../../apps/api/src/modules/aigc/bailian-commerce-voice.js", () => ({
  currentBailianCommerceVoices: async (actor: { id: string }) =>
    actor.id === "8"
      ? [
          {
            id: bailianVoice,
            name: "北京音色",
            model: "qwen-audio-3.1-tts-plus",
          },
        ]
      : [],
  bailianCommerceVoiceCatalog: async () => ({ configured: true, models: [] }),
  advanceBailianCommerceSpeech: vi.fn(async () => ({
    status: "ready",
    audio: Buffer.from("tested MP3 boundary"),
  })),
}));

vi.mock(
  "../../apps/api/src/modules/aigc/commerce-fal.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../apps/api/src/modules/aigc/commerce-fal.js")
      >();
    return {
      ...actual,
      startCommerceFalVideo: vi.fn(async () => ({
        operationId: "0b01558d-e7c8-4a7d-b524-26954a545cf3",
        status: "queued",
      })),
    };
  },
);
import { startCommerceFalVideo } from "../../apps/api/src/modules/aigc/commerce-fal.js";

vi.mock("../../apps/api/src/modules/workspace/agentai-audio.js", () => ({
  commerceClonedVoices: async (actor: { id: string }) =>
    actor.id === "1" ? [{ id: "personal-voice", name: "我的音色" }] : [],
  advanceCommerceSpeech: vi.fn(async () => ({
    task: { status: "processing", errorNote: "" },
  })),
}));

it("saves a private photo and routes its Bailian voice to fal with the old service absent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "commerce-fal-profile-"));
  const owner = {
    id: "8",
    username: "owner",
    displayName: "Owner",
    role: "operator",
    permissions: ["aigc.use", "product.read"],
  };
  const guest = { ...owner, id: "9" };
  const engine = await createStudio({
    config: {
      dataDir: dir,
      videoSecrets: {},
      openrouterApiKey: "test",
      falLipSyncApiKey: "test",
      sessionSecret: "test",
      publicBaseUrl: "https://xuti.example",
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
  try {
    engine.digitalHuman.lipSync.configured = () => true;
    const before = await commercePresenterOptions(engine, owner);
    expect(before.readiness).toMatchObject({
      script: true,
      presenter: true,
      fal: true,
      profile: false,
    });
    expect(before.templates).toEqual([]);
    const photo = await sharp({
      create: { width: 300, height: 400, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(photo)], "sample.png", { type: "image/png" }),
    );
    form.set("requestId", randomUUID());
    form.set("name", "参考照片");
    form.set("authorized", "true");
    const input = new globalThis.Request("https://xuti.example", {
      method: "POST",
      body: form,
    });
    const req = Object.assign(
      Readable.from([Buffer.from(await input.arrayBuffer())]),
      {
        is: () => true,
        get: (name: string) => input.headers.get(name),
      },
    ) as unknown as Request;
    const uploaded = await uploadCommercePresenterPortrait(engine, owner, req);
    expect(uploaded.avatar?.engine).toBe("fal");
    expect((await commercePresenterOptions(engine, guest)).avatars).toEqual([]);
    const details = {
      name: "试听主播",
      voiceId: `bailian:${bailianVoice}`,
      avatarId: uploaded.avatar!.id,
      authorized: true,
    };
    const saved = await saveCommercePresenter(engine, owner, details);
    expect(saved).toMatchObject({
      engine: "fal",
      voiceProvider: "bailian",
      voiceModel: "qwen-audio-3.1-tts-plus",
    });
    const runId = randomUUID();
    expect(
      await startCommercePresenterVideo(engine, owner, {
        runId,
        presenterId: saved.id,
        text: "请看一下这件外套。",
        maxSpeechCny: 0.1,
      }),
    ).toMatchObject({ status: "queued" });
    expect(advanceBailianCommerceSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ actor: owner }),
      {
        runId,
        voiceId: bailianVoice,
        text: "请看一下这件外套。",
        maxCny: 0.1,
      },
    );
    expect(startCommerceFalVideo).toHaveBeenCalledWith(
      engine,
      expect.objectContaining({ id: owner.id }),
      {
        portraitId: uploaded.avatar!.id,
        presenterId: saved.id,
      },
      runId,
      Buffer.from("tested MP3 boundary"),
    );
  } finally {
    engine.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

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
