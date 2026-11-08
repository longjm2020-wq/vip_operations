import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  videoCatalog,
  selectVideoRoute,
  submitVideo,
  pollVideo,
  // @ts-expect-error JavaScript provider contract.
} from "../../packages/aigc-engine/vendor/cloud/video-providers.mjs";
import {
  prepareBailianImages,
  bailianVideoBaseUrl,
  // @ts-expect-error JavaScript provider contract.
} from "../../packages/aigc-engine/vendor/cloud/bailian-video.mjs";
import {
  referenceDownloadOwner,
  validateReferenceFiles,
  // @ts-expect-error JavaScript ownership contract.
} from "../../packages/aigc-engine/vendor/cloud/media-references.mjs";
// @ts-expect-error JavaScript routing contract.
import { selectionForSave } from "../../packages/aigc-engine/vendor/cloud/customer-view.mjs";
import { aigcModelManagement } from "../../packages/aigc-engine/model-management.mjs";
// @ts-expect-error JavaScript pricing contract.
import { quoteVideo } from "../../packages/aigc-engine/vendor/cloud/video-pricing.mjs";

const config = {
  bailianWorkspaceId: "ws-fixture12345678",
  videoSecrets: { BAILIAN_VIDEO_API_KEY: "sk-fixture-never-real" },
  enabledVideoProviders: ["bailian"],
  defaultVideoSelection: { providerId: "bailian", modelId: "minimax-h3" },
  publicVideoProvider: "bailian",
  publicBaseUrl: "https://website.test",
  sessionSecret: "test-signing-key",
};
const route = () => selectVideoRoute(config, config.defaultVideoSelection);
const input = () => ({
  prompt: "测试商品展示",
  duration: 4,
  aspectRatio: "16:9",
  referenceImages: [
    "https://website.test/image-one",
    "https://website.test/image-two",
  ],
  referenceVideos: ["https://website.test/reference-video"],
  referenceAudios: ["https://website.test/reference-audio"],
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
afterEach(() => vi.unstubAllGlobals());

it("offers only the exact Bailian H3 route while retaining old submitted routes for polling", () => {
  const catalog = videoCatalog(config);
  expect(catalog.map((p: any) => p.id)).toEqual(["bailian"]);
  expect(catalog[0].models.map((m: any) => m.id)).toEqual(["minimax-h3"]);
  expect(catalog[0].models[0]).toMatchObject({
    configured: true,
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolutions: ["768P", "2K"],
    maxImages: 9,
  });
  const managed = aigcModelManagement(config, undefined).find(
    (row) => row.id === "aigc_video",
  )!;
  expect(managed.model).toBe("MiniMax/MiniMax-H3");
  expect(managed.choices.map((choice) => choice.value)).toEqual([
    "bailian|minimax-h3",
  ]);
  expect(
    selectVideoRoute(config, { providerId: "xai", modelId: "grok" }).protocol,
  ).toBe("xai");
  expect(() =>
    selectionForSave({ role: "super_admin" }, config, {
      providerId: "xai",
      modelId: "grok",
    }),
  ).toThrow(/移出可选列表/);
  expect(selectionForSave({ role: "operator" }, config, {})).toMatchObject({
    providerId: "bailian",
    modelId: "minimax-h3",
    resolution: "768P",
  });
  expect(JSON.stringify(catalog)).not.toContain("sk-fixture");
});
it("requires a workspace and never permits arbitrary credential destinations", () => {
  expect(() => bailianVideoBaseUrl("ws-evil.test/path")).toThrow();
  expect(
    videoCatalog({ ...config, bailianWorkspaceId: "" })[0].configured,
  ).toBe(false);
});
it("submits the documented async request and exact multimodal asset types", async () => {
  const spy = vi.fn(async () =>
    json({
      request_id: "submit-request",
      output: { task_id: "video-task-1", task_status: "PENDING" },
    }),
  );
  vi.stubGlobal("fetch", spy);
  expect(await submitVideo(config, route(), input())).toBe("video-task-1");
  const [url, options] = spy.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(
    "https://ws-fixture12345678.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
  );
  expect(options.headers).toMatchObject({
    "X-DashScope-Async": "enable",
    Authorization: "Bearer sk-fixture-never-real",
  });
  expect(JSON.parse(String(options.body))).toEqual({
    model: "MiniMax/MiniMax-H3",
    input: {
      prompt: "测试商品展示",
      media: [
        { type: "image_url", url: input().referenceImages[0] },
        { type: "image_url", url: input().referenceImages[1] },
        { type: "feature", url: input().referenceVideos[0] },
        { type: "driving_audio", url: input().referenceAudios[0] },
      ],
    },
    parameters: {
      resolution: "768P",
      duration: 4,
      ratio: "16:9",
      watermark: true,
    },
  });
});
it.each([
  { duration: 3 },
  { duration: 16 },
  { aspectRatio: "3:2" },
  { referenceImages: Array(10).fill("https://example.test/image") },
  { referenceVideos: Array(4).fill("https://example.test/video") },
])(
  "rejects unsupported inputs before creating a paid task: %j",
  async (patch) => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(
      submitVideo(config, route(), { ...input(), ...patch }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  },
);
it("requires public HTTPS images at submission and preserves uncertain task creation", async () => {
  const spy = vi.fn();
  vi.stubGlobal("fetch", spy);
  await expect(
    submitVideo(config, route(), {
      ...input(),
      referenceImages: [
        "data:image/png;base64,eA==",
        "https://website.test/image",
      ],
    }),
  ).rejects.toThrow(/HTTPS/);
  expect(spy).not.toHaveBeenCalled();
  spy.mockResolvedValue(
    json({
      request_id: "request-without-task",
      output: { task_status: "PENDING" },
    }),
  );
  await expect(submitVideo(config, route(), input())).rejects.toThrow(
    /请勿重复生成/,
  );
  expect(spy).toHaveBeenCalledTimes(1);
});
it("polls without resubmission, records only the terminal receipt, and rejects task mismatches", async () => {
  const receipt = vi.fn(async () => {}),
    cfg = { ...config, recordAiReceipt: receipt };
  const spy = vi.fn(async () =>
    json({ output: { task_id: "task-1", task_status: "RUNNING" } }),
  );
  vi.stubGlobal("fetch", spy);
  expect(await pollVideo(cfg, route(), "task-1")).toMatchObject({
    pending: true,
  });
  expect(receipt).not.toHaveBeenCalled();
  const result = {
    request_id: "query-request",
    output: {
      task_id: "task-1",
      task_status: "SUCCEEDED",
      video_url: "https://media.example.test/result.mp4",
    },
    usage: { input_seconds: 3, output_seconds: 4, image_count: 0 },
  };
  spy.mockResolvedValue(json(result));
  expect(await pollVideo(cfg, route(), "task-1")).toMatchObject({
    pending: false,
    state: "success",
    url: result.output.video_url,
  });
  expect(receipt).toHaveBeenCalledWith(
    "aigc_video",
    "ws-fixture12345678.cn-beijing.maas.aliyuncs.com",
    "MiniMax/MiniMax-H3",
    result,
  );
  expect(
    (spy.mock.calls[0] as unknown as [string, RequestInit])[1].method,
  ).toBe("GET");
  spy.mockResolvedValue(
    json({
      output: {
        task_id: "another-task",
        task_status: "SUCCEEDED",
        video_url: "https://example.test/not-ours",
      },
    }),
  );
  await expect(pollVideo(cfg, route(), "task-1")).rejects.toThrow(/编号不匹配/);
});
it("reports safe provider failure codes without echoing prompts, URLs or credentials", async () => {
  const spy = vi.fn(async () =>
    json({
      output: {
        task_id: "failed-task",
        task_status: "FAILED",
        code: "InvalidParameter",
        message:
          "duration is invalid; secret prompt https://private.example.test sk-private-secret",
      },
    }),
  );
  vi.stubGlobal("fetch", spy);
  const result = await pollVideo(config, route(), "failed-task");
  expect(result).toMatchObject({
    state: "failed",
    errorCode: "InvalidParameter",
    errorHint: "供应商拒绝请求参数（duration / prompt）",
  });
  expect(JSON.stringify(result)).not.toMatch(/secret|private/);
  expect(spy).toHaveBeenCalledTimes(1);
  const diagnostic = await pollVideo(
    { ...config, bailianTestDiagnostics: true },
    route(),
    "failed-task",
  );
  expect(diagnostic.errorDiagnostic).toContain("duration is invalid");
  expect(diagnostic.errorDiagnostic).not.toMatch(
    /sk-private-secret|https:\/\/private.example.test/,
  );
});
it("keeps media limits and the explicit price estimate separate from actual bills", () => {
  const model = route().model;
  const clip = {
    name: "ref.mp4",
    size: 100,
    mediaInfo: { durationSeconds: 5, width: 768, height: 768, fps: 24 },
  };
  expect(() =>
    validateReferenceFiles(model, "video", [clip, clip, clip]),
  ).not.toThrow();
  expect(() =>
    validateReferenceFiles(model, "video", [
      { ...clip, mediaInfo: { ...clip.mediaInfo, durationSeconds: 16 } },
    ]),
  ).toThrow();
  expect(() =>
    validateReferenceFiles(model, "video", [
      { ...clip, mediaInfo: { ...clip.mediaInfo, width: 100 } },
    ]),
  ).toThrow();
  const quote = quoteVideo(route(), {
    durations: [4],
    imageCount: 7,
    aspectRatio: "16:9",
    referenceVideoSeconds: 3,
  });
  expect(quote.pricing.currency).toBe("CNY");
  expect(quote.totals[0]).toMatchObject({
    output: 2,
    images: 0.4,
    videoReferences: 1.5,
    total: 3.9,
  });
});
it("serves processed images only through expiring links bound to the matching owner and live job", async () => {
  const png = await sharp({
    create: { width: 256, height: 256, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const uri = `data:image/png;base64,${png.toString("base64")}`;
  const job: any = {
    id: "job-1",
    projectId: "project-1",
    ownerId: "owner-1",
    status: "running",
    payload: { videoRoute: route() },
  };
  const assets: any = {};
  let created = 0;
  const store = {
    getJob: () => job,
    getAssetMetadata: (id: string) => assets[id],
    openAsset: async (id: string) => assets[id],
    mutate: async (fn: any) => fn({ jobs: { "job-1": job } }),
    putAsset: async (value: any) => {
      const id = `image-${++created}`;
      assets[id] = { ...value, id };
      return { path: id };
    },
  };
  const prepared = await prepareBailianImages(store, config, job, "unit-1", [
    uri,
    uri,
  ]);
  const url = new URL(prepared.urls[0]);
  expect(
    referenceDownloadOwner(store, config, "image-1", url.searchParams),
  ).toBe("owner-1");
  job.status = "waiting_provider";
  expect(
    referenceDownloadOwner(store, config, "image-1", url.searchParams),
  ).toBe("owner-1");
  await prepareBailianImages(store, config, job, "unit-1", [uri, uri]);
  expect(created).toBe(2);
  assets["image-1"].ownerId = "another-owner";
  expect(
    referenceDownloadOwner(store, config, "image-1", url.searchParams),
  ).toBeNull();
  assets["image-1"].ownerId = "owner-1";
  job.status = "completed";
  expect(
    referenceDownloadOwner(store, config, "image-1", url.searchParams),
  ).toBeNull();
  job.status = "running";
  url.searchParams.set("expires", "1");
  expect(
    referenceDownloadOwner(store, config, "image-1", url.searchParams),
  ).toBeNull();
});
