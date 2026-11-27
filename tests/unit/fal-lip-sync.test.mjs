import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import sharp from "sharp";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { FAL_LIP_SYNC_MODEL, FalLipSyncService } from "../../packages/aigc-engine/vendor/cloud/fal-lip-sync.mjs";
import { referenceDownloadOwner } from "../../packages/aigc-engine/vendor/cloud/media-references.mjs";
import { commerceFalConfigured, commerceFalOwnsVideo, findCommerceFalVideo, readCommerceFalVideo, startCommerceFalVideo } from "../../apps/api/src/modules/aigc/commerce-fal.js";

const owner = { id: "7" };
const stranger = { id: "8" };
const queue = "https://queue.fal.run";
const submitUrl = `${queue}/${FAL_LIP_SYNC_MODEL}`;
const remoteId = "5bacbc41-5f51-4b9c-890b-a62ecc1ca323";
const resultUrl = `${queue}/minimax/h3-max/requests/${remoteId}`;
const cdnUrl = "https://v3b.fal.media/files/b/example/clip.mp4";
const tokenUrl = "https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3";
let image;
let audio;
let video;
const run = promisify(execFile);

beforeAll(async () => {
  const photo = await sharp({ create: { width: 320, height: 400, channels: 3, background: "grey" } }).png().toBuffer();
  const tone = "sine=frequency=440:sample_rate=8000:duration=6";
  const wave = await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", tone, "-f", "wav", "pipe:1"], { encoding: "buffer" });
  const sample = await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=s=320x400:r=10:d=6", "-f", "lavfi", "-i", tone, "-c:v", "libx264", "-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"], { encoding: "buffer" });
  image = new File([photo], "person.png", { type: "image/png" });
  audio = new File([wave.stdout], "original.wav", { type: "audio/wav" });
  video = sample.stdout;
});

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const bytes = new Map();
  const store = {
    assetsDir: tmpdir(),
    data: { digitalHuman: { operations: {} }, assets: {}, appState: { works: [] } },
    async mutate(callback) {
      const draft = structuredClone(this.data);
      const result = callback(draft);
      this.data = draft;
      return structuredClone(result);
    },
    getAssetMetadata(id) { return this.data.assets[id]; },
    async readAsset(id) {
      const metadata = this.getAssetMetadata(id);
      return metadata ? { metadata, buffer: bytes.get(id) } : null;
    },
    async putAsset({ buffer, ...value }) {
      const id = randomUUID();
      bytes.set(id, Buffer.from(buffer));
      this.data.assets[id] = { ...value, id, size: buffer.length, storageName: `${id}.bin`, createdAt: new Date().toISOString() };
      return { ...value, path: id, size: buffer.length };
    },
  };
  const fakeFetch = vi.fn();
  const recordAiReceipt = vi.fn(async () => {});
  const config = { falLipSyncApiKey: "test-only-key", publicBaseUrl: "https://xuti.example", sessionSecret: "test-only-secret", aiFetch: async (feature, url, options) => {
    expect(feature).toBe("aigc_lip_sync");
    return fakeFetch(url, options);
  }, recordAiReceipt };
  vi.stubGlobal("fetch", fakeFetch);
  return { config, store, fakeFetch, recordAiReceipt, service: new FalLipSyncService(store, config) };
}

const inputFor = () => ({ requestId: randomUUID(), authorized: "true", image, audio });

async function commerceFixture() {
  const { config, store, service, fakeFetch } = fixture();
  const jpeg = await sharp(Buffer.from(await image.arrayBuffer())).jpeg().toBuffer();
  const photo = await store.putAsset({
    ownerId: owner.id, name: "portrait.jpg", mime: "image/jpeg", buffer: jpeg,
    source: "commerce-presenter-portrait", kind: "commerce-presenter-portrait",
  });
  const profile = { presenterId: randomUUID(), portraitId: photo.path };
  store.data.digitalHuman.commercePresenters = {
    [profile.presenterId]: {
      ownerId: owner.id, engine: "fal", avatarId: profile.portraitId,
      authorizedAt: new Date().toISOString(),
    },
  };
  return { config, store, service, fakeFetch, profile, studio: { store, digitalHuman: { lipSync: service } } };
}

async function narration(seconds) {
  const { stdout } = await run(ffmpeg, [
    "-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=24000:duration=${seconds}`,
    "-c:a", "libmp3lame", "-f", "mp3", "pipe:1",
  ], { encoding: "buffer" });
  return stdout;
}

test("sends each authorized pair once through the canonical fal queue and archives an authenticated MP4", async () => {
  const { service, config, store, fakeFetch, recordAiReceipt } = fixture();
  let signedSource;
  fakeFetch.mockImplementation(async (url, options) => {
    expect(options.redirect).toBe("error");
    if (url === submitUrl) {
      expect(options.headers.Authorization).toBe("Key test-only-key");
      expect(options.headers["X-Fal-No-Retry"]).toBe("1");
      expect(JSON.parse(options.headers["X-Fal-Object-Lifecycle-Preference"]).initial_acl.default).toBe("forbid");
      const body = JSON.parse(options.body);
      const sources = [new URL(body.image_url), new URL(body.audio_url)];
      expect(body.resolution).toBe("768P");
      expect(body.enable_safety_checker).toBe(true);
      for (const item of sources) {
        const assetId = item.pathname.split("/").at(-1);
        expect(referenceDownloadOwner(store, config, assetId, item.searchParams)).toBe(owner.id);
        const forged = new URLSearchParams(item.searchParams);
        forged.set("job", randomUUID());
        expect(referenceDownloadOwner(store, config, assetId, forged)).toBeNull();
      }
      signedSource = sources[0];
      return Response.json({ request_id: remoteId, status_url: "https://unexpected.example/token" });
    }
    if (url === `${resultUrl}/status`) return Response.json({ request_id: remoteId, status: "COMPLETED" });
    if (url === resultUrl) return Response.json({ video: { url: cdnUrl }, duration: 6 });
    if (url === tokenUrl) return Response.json({ token: "test-only-cdn-token" });
    if (url === cdnUrl) {
      expect(options.headers.Authorization).toBe("Bearer test-only-cdn-token");
      return new Response(video, { headers: { "Content-Type": "video/mp4" } });
    }
    throw Error("unexpected network request");
  });
  const input = inputFor();
  expect(service.catalog(owner).verifiedAt).toBeUndefined();
  const request = () => Promise.resolve(input);
  const job = await service.create(owner, request);
  expect(await service.create(owner, request)).toEqual(job);
  await service.tick();
  await service.tick();
  const catalog = service.catalog(owner);
  expect(catalog.jobs[0]).toMatchObject({ id: job.id, status: "completed", duration: 6 });
  expect(catalog.jobs[0].output).toBe(store.data.appState.works[0].videos[0].path);
  expect(catalog.verifiedAt).toBeTruthy();
  expect(service.catalog(stranger).jobs).toEqual([]);
  expect(Object.values(store.data.assets).map(asset => asset.kind)).toEqual(["output"]);
  expect(referenceDownloadOwner(store, config, signedSource.pathname.split("/").at(-1), signedSource.searchParams)).toBeNull();
  expect(recordAiReceipt).toHaveBeenCalledWith("aigc_lip_sync", "queue.fal.run", FAL_LIP_SYNC_MODEL, { request_id: remoteId, status: "completed", model: FAL_LIP_SYNC_MODEL, duration: 6 });
  expect(fakeFetch.mock.calls.filter(([url]) => url === submitUrl)).toHaveLength(1);
  config.falLipSyncApiKey = "replacement-key";
  expect(service.catalog(owner).verifiedAt).toBeUndefined();
});

test("preserves a lost submission receipt and refuses to charge again automatically", async () => {
  const { service, fakeFetch } = fixture();
  const input = inputFor();
  fakeFetch.mockRejectedValue(Error("connection reset after submit"));
  await expect(service.create(owner, async () => ({ ...input, authorized: "false" }))).rejects.toThrow("使用授权");
  await service.create(owner, async () => input);
  await service.tick();
  await service.tick();
  expect(fakeFetch).toHaveBeenCalledTimes(1);
  expect(service.catalog(owner).jobs[0].status).toBe("uncertain");
  await expect(service.create(owner, async () => inputFor())).rejects.toThrow("核实当前原声口播任务");
  expect(fakeFetch).toHaveBeenCalledTimes(1);
});

test("reuse of Fal for clothes publishes only the final commercial work downstream", { timeout: 45000 }, async () => {
  const { studio, store, service, fakeFetch, profile } = await commerceFixture();
  const original = await service.create(owner, async () => inputFor());
  store.data.digitalHuman.operations[original.id].status = "uncertain";
  const runId = randomUUID();
  expect(commerceFalConfigured(studio)).toBe(true);
  const speech = await narration(6);
  const queued = await startCommerceFalVideo(studio, owner, profile, runId, speech);
  expect(queued.status).toBe("queued");
  expect(findCommerceFalVideo(studio, owner, runId, profile)).toEqual(queued);
  expect(findCommerceFalVideo(studio, stranger, runId)).toBeUndefined();
  await expect(startCommerceFalVideo(studio, owner, { ...profile, presenterId: randomUUID() }, runId, speech))
    .rejects.toMatchObject({ status: 409 });
  expect(await startCommerceFalVideo(studio, owner, profile, runId, speech)).toEqual(queued);
  expect((await startCommerceFalVideo(studio, owner, profile, randomUUID(), speech)).status)
    .toBe("awaiting_presenter");
  expect(service.catalog(owner).jobs.map(item => item.id)).toEqual([original.id]);
  fakeFetch.mockImplementation(async (url) => {
    if (url === submitUrl) return Response.json({ request_id: remoteId });
    if (url === resultUrl + "/status") return Response.json({ request_id: remoteId, status: "COMPLETED" });
    if (url === resultUrl) return Response.json({ video: { url: cdnUrl }, duration: 6 });
    if (url === tokenUrl) return Response.json({ token: "fixture-no-secret" });
    if (url === cdnUrl) return new Response(video, { headers: { "content-type": "video/mp4" } });
    throw Error("unexpected network request");
  });
  await service.tick();
  await service.tick();
  expect(commerceFalOwnsVideo(studio, owner, queued.operationId)).toBe(true);
  expect(commerceFalOwnsVideo(studio, stranger, queued.operationId)).toBe(false);
  expect((await readCommerceFalVideo(studio, owner, queued.operationId)).content).toEqual(video);
  expect(store.data.appState.works).toEqual([]);
  expect(fakeFetch.mock.calls.filter(([url]) => url === submitUrl)).toHaveLength(1);
  await expect(readCommerceFalVideo(studio, stranger, queued.operationId)).rejects.toMatchObject({ status: 404 });
});

test("pads short speech and compresses moderately long speech without billing unconsented footage", { timeout: 45000 }, async () => {
  const { studio, store, service, fakeFetch, profile } = await commerceFixture();
  const short = await startCommerceFalVideo(studio, owner, profile, randomUUID(), await narration(2));
  const shortOp = store.data.digitalHuman.operations[short.operationId];
  expect(shortOp.inputDuration).toBeGreaterThanOrEqual(5);
  expect(shortOp.inputDuration).toBeLessThan(5.3);
  shortOp.status = "uncertain";
  const long = await startCommerceFalVideo(studio, owner, profile, randomUUID(), await narration(18));
  const longOp = store.data.digitalHuman.operations[long.operationId];
  expect(longOp.inputDuration).toBeLessThanOrEqual(15);
  expect(longOp.inputDuration).toBeGreaterThan(14.5);
  // Revoke authorization after queuing the job, while the engine saves its submission state.
  const mutate = store.mutate.bind(store);
  store.mutate = async (callback) => {
    const result = await mutate(callback);
    if (store.data.digitalHuman.operations[long.operationId].status === "submitting")
      store.data.digitalHuman.commercePresenters[profile.presenterId].revokedAt = new Date().toISOString();
    return result;
  };
  await service.tick();
  expect((await readCommerceFalVideo(studio, owner, long.operationId)).status).toBe("failed");
  expect(fakeFetch).not.toHaveBeenCalled();
  delete store.data.digitalHuman.commercePresenters[profile.presenterId].revokedAt;
  await expect(startCommerceFalVideo(studio, owner, profile, randomUUID(), await narration(20)))
    .rejects.toMatchObject({ status: 400 });
  expect(fakeFetch).not.toHaveBeenCalled();
});
