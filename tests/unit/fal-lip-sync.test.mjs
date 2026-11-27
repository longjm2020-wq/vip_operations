import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import sharp from "sharp";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { FAL_LIP_SYNC_MODEL, FalLipSyncService } from "../../packages/aigc-engine/vendor/cloud/fal-lip-sync.mjs";
import { referenceDownloadOwner } from "../../packages/aigc-engine/vendor/cloud/media-references.mjs";

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
    async putAsset({ buffer, ...value }) {
      const id = randomUUID();
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
