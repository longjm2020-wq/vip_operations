import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  AGENTAI_IMAGES,
  AGENTAI_VIDEOS,
  agentaiConfigured,
  validateAgentAiParams,
  uploadAgentAiImages,
  prepareAgentAi,
  submitAgentAi,
  pollAgentAi,
  // @ts-expect-error JavaScript media adapter.
} from "../../packages/aigc-engine/vendor/cloud/agentai-media.mjs";
import {
  imageCatalog,
  keyframeImageRoute,
  keyframeImageBody,
  dryRunKeyframe,
  submitKeyframe,
  pollKeyframe,
  // @ts-expect-error JavaScript image provider.
} from "../../packages/aigc-engine/vendor/cloud/image-provider.mjs";
import {
  videoCatalog,
  selectVideoRoute,
  videoRequestBody,
  preflightXhaiVideo,
  submitVideo,
  pollVideo,
  // @ts-expect-error JavaScript video provider.
} from "../../packages/aigc-engine/vendor/cloud/video-providers.mjs";
import { aigcModelManagement } from "../../packages/aigc-engine/model-management.mjs";
import { withJobSignal } from "../../packages/aigc-engine/team-video.mjs";

// Technical fields copied from the real public catalogue, not schemas invented
// to fit our adapter. The source and capture date are retained in the fixture.
const snapshot = JSON.parse(
  readFileSync(
    new URL("../fixtures/agentai-media-models.json", import.meta.url),
    "utf8",
  ),
);
const config = () => ({
  videoSecrets: {
    AGENTAI_API_KEY: "agentai-fixture-key",
    XHAI_API_KEY: "xhai-different-key",
  },
  agentaiModels: structuredClone(snapshot.models),
  enabledVideoProviders: ["agentai"],
  defaultVideoSelection: { providerId: "agentai", modelId: "minimax-h3" },
  keyframeImageModel: "agentai-gm-3-pro-image",
});
const images = [
  "https://assets.test/person.png",
  "https://assets.test/product.png",
];
const input = (duration = 4) => ({
  prompt: "以人物和商品参考图生成服装展示，不改变商品细节",
  duration,
  aspectRatio: "16:9",
  referenceImages: [...images],
});
const imageBody = (cfg = config(), id = "agentai-gm-3-pro-image") =>
  keyframeImageBody(keyframeImageRoute(cfg, { modelId: id }), {
    prompt: input().prompt,
    images,
    aspectRatio: "16:9",
  });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const estimate = (pinned = false, duration?: number) => ({
  effective_total_rmb: 2.5,
  max_effective_total_rmb: pinned ? 2.5 : 5,
  required_freeze_rmb: 2.5,
  channels: [{ lane: "documented-lane", is_delivery_head: true }],
  ...(duration ? { price_basis: { output_duration_sec: duration } } : {}),
});
const stubProtocol = (invoke: unknown = { task_id: "paid-task-1" }) => {
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (new URL(url).pathname === "/v1/pricing-estimate")
      return json(
        estimate(
          !!body.pinned_lane_id,
          Number(body.params.duration) || undefined,
        ),
      );
    if (new URL(url).pathname === "/api/v1/model-runtime/invoke")
      return json(invoke);
    throw Error("unexpected network path");
  });
  vi.stubGlobal("fetch", spy);
  return spy;
};
afterEach(() => vi.unstubAllGlobals());

it("offers exactly four reviewed image and three video adapters with independent authenticated availability", () => {
  const cfg = config();
  expect(snapshot.models).toHaveLength(7);
  expect(
    imageCatalog(cfg, "operator").models.filter((m: any) =>
      m.id.startsWith("agentai-"),
    ),
  ).toHaveLength(4);
  expect(videoCatalog(cfg).map((p: any) => p.id)).toEqual(["agentai"]);
  expect(videoCatalog(cfg)[0].models).toHaveLength(3);
  expect(videoCatalog(cfg)[0].models.every((m: any) => m.configured)).toBe(
    true,
  );
  expect(
    agentaiConfigured(
      { ...cfg, videoSecrets: { XHAI_API_KEY: "xhai-only" } },
      "minimax-h3",
    ),
  ).toBe(false);
  expect(agentaiConfigured({ ...cfg, agentaiModels: [] }, "minimax-h3")).toBe(
    false,
  );
  cfg.agentaiModels.find((m: any) => m.model === "minimax-h3").available =
    false;
  expect(
    videoCatalog(cfg)[0].models.find((m: any) => m.id === "minimax-h3")
      .configured,
  ).toBe(false);
  const managed = aigcModelManagement(config(), undefined);
  const image = managed.find((row) => row.id === "aigc_image")!;
  const video = managed.find((row) => row.id === "aigc_video")!;
  expect(image).toMatchObject({ model: "gm-3-pro-image", configured: true });
  expect(image.source).toContain("https://agentai.token6688.com");
  expect(
    video.choices.every((choice) =>
      choice.source?.includes("agentai.token6688.com"),
    ),
  ).toBe(true);
  expect(
    video.choices.every(
      (choice) => !choice.boundary?.includes("仅限超级管理员"),
    ),
  ).toBe(true);
  expect(
    JSON.stringify([imageCatalog(config()), videoCatalog(config()), managed]),
  ).not.toContain("fixture-key");
});

const imageCases: [string, string][] = AGENTAI_IMAGES.map((m: any) => [
  m.id,
  m.model,
]);
it.each(imageCases)(
  "constructs %s from its real official schema for every advertised aspect ratio",
  (id, model) => {
    const cfg = config();
    const definition = AGENTAI_IMAGES.find((m: any) => m.id === id);
    for (const aspectRatio of definition.aspects) {
      const body = keyframeImageBody(keyframeImageRoute(cfg, { modelId: id }), {
        prompt: input().prompt,
        images,
        aspectRatio,
      });
      expect(validateAgentAiParams(cfg, body)).toBe(definition);
      expect(body).toMatchObject({
        model_id: model,
        modality: "image",
        operation: "generate",
        params: {
          mode: "multi-reference",
          count: 1,
          [definition.sizeField]: "2K",
        },
      });
      expect(
        body.params[definition.sizeField === "size" ? "resolution" : "size"],
      ).toBeUndefined();
    }
  },
);

const videoCases: string[] = AGENTAI_VIDEOS.map((m: any) => m.id);
it.each(videoCases)(
  "constructs %s with official duration/resolution/aspect enums and no invented video/audio capabilities",
  (id) => {
    const cfg = config();
    const model = AGENTAI_VIDEOS.find((m: any) => m.id === id);
    for (const resolution of model.resolutions)
      for (const duration of model.durations)
        for (const aspectRatio of model.aspects) {
          const route = selectVideoRoute(cfg, {
            providerId: "agentai",
            modelId: id,
            resolution,
          });
          const body = videoRequestBody(route, {
            ...input(duration),
            aspectRatio,
          });
          expect(validateAgentAiParams(cfg, body)).toBe(model);
          expect(body.params).toMatchObject({
            duration: String(duration),
            resolution,
            mode: "reference",
            count: 1,
          });
          if (id === "vo-3.1") expect(body.params.quality).toBe("快速");
        }
    const route = selectVideoRoute(cfg, { providerId: "agentai", modelId: id });
    expect(() =>
      videoRequestBody(route, {
        ...input(model.durations[0]),
        referenceAudios: ["https://assets.test/a.mp3"],
      }),
    ).toThrow(/不会静默丢弃/);
    expect(() =>
      videoRequestBody(route, {
        ...input(model.durations[0]),
        referenceVideos: ["https://assets.test/a.mp4"],
      }),
    ).toThrow(/不会静默丢弃/);
  },
);

it("rejects incompatible synchronized schema, required new parameters, or too many references before any network call", async () => {
  const cfg = config(),
    body = imageBody(cfg);
  const spy = vi.fn();
  vi.stubGlobal("fetch", spy);
  cfg.agentaiModels.find(
    (m: any) => m.publicId === body.model_id,
  ).paramSchema.size.enum = ["1K"];
  await expect(prepareAgentAi(cfg, body)).rejects.toThrow(/不支持所选/);
  const next = config();
  next.agentaiModels.find(
    (m: any) => m.publicId === body.model_id,
  ).paramSchema.new_required = { required: true, type: "string" };
  await expect(prepareAgentAi(next, body)).rejects.toThrow(/新增必填参数/);
  await expect(
    prepareAgentAi(config(), {
      ...body,
      params: { ...body.params, images: Array(15).fill(images[0]) },
    }),
  ).rejects.toThrow(/参考图/);
  expect(spy).not.toHaveBeenCalled();
});

it("uploads validated image bytes once, using only the independent AgentAI key and documented multipart endpoint", async () => {
  const bytes = await sharp({
    create: { width: 320, height: 320, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const source = `data:image/png;base64,${bytes.toString("base64")}`;
  const spy = vi.fn(async () =>
    json({ url: "https://files.agentai.test/image.png" }, 201),
  );
  vi.stubGlobal("fetch", spy);
  expect(
    await uploadAgentAiImages(config(), "minimax-h3", [source, source]),
  ).toEqual([
    "https://files.agentai.test/image.png",
    "https://files.agentai.test/image.png",
  ]);
  expect(spy).toHaveBeenCalledTimes(1);
  const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://agentai.token6688.com/v1/files");
  expect(init.headers).toEqual({ Authorization: "Bearer agentai-fixture-key" });
  expect(init.body).toBeInstanceOf(FormData);
  expect((init.body as FormData).get("file")).toBeInstanceOf(Blob);
  const small = await sharp(bytes).resize(200, 200).toBuffer();
  await expect(
    uploadAgentAiImages(config(), "minimax-h3", [
      `data:image/png;base64,${small.toString("base64")}`,
    ]),
  ).rejects.toThrow(/尺寸/);
  const wide = await sharp(bytes).resize(1000, 320).toBuffer();
  await expect(
    uploadAgentAiImages(config(), "minimax-h3", [
      `data:image/png;base64,${wide.toString("base64")}`,
    ]),
  ).rejects.toThrow(/尺寸/);
  expect(spy).toHaveBeenCalledTimes(1);
});

it("performs two free pinned estimates then exactly one image invoke through shared metering", async () => {
  const cfg = config(),
    route = keyframeImageRoute(cfg),
    body = imageBody(cfg);
  const spy = stubProtocol();
  const aiFetch = vi.fn((feature: string, url: string, init: RequestInit) => {
    expect(feature).toBe("aigc_image");
    return fetch(url, init);
  });
  const runtime = { ...cfg, aiFetch };
  await dryRunKeyframe(runtime, route, body);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(aiFetch).not.toHaveBeenCalled();
  expect(await submitKeyframe(runtime, route, body)).toBe("paid-task-1");
  expect(aiFetch).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledTimes(3);
  const requests = spy.mock.calls.map(([url, init]) => ({
    url: new URL(url).pathname,
    body: JSON.parse(String(init?.body)),
  }));
  expect(requests[0].url).toBe("/v1/pricing-estimate");
  expect(requests[1].body.pinned_lane_id).toBe("documented-lane");
  expect(requests[2]).toMatchObject({
    url: "/api/v1/model-runtime/invoke",
    body: {
      model_id: "gm-3-pro-image",
      lane_id: "documented-lane",
      modality: "image",
    },
  });
  expect(requests[2].body.client_request_id).toMatch(/^[\da-f-]{36}$/);
  expect(
    spy.mock.calls.every(([, init]) =>
      JSON.stringify(init?.headers).includes("agentai-fixture-key"),
    ),
  ).toBe(true);
});

it("requires a video estimate for the exact submitted input and preserves provider task IDs if adjustments follow submission", async () => {
  const cfg = config(),
    route = selectVideoRoute(cfg, cfg.defaultVideoSelection);
  const spy = stubProtocol({
    task_id: "adjusted-task",
    param_adjustments: [
      {
        param: "duration",
        requested: "4",
        applied: "5",
        reason: "nearest_supported",
      },
    ],
  });
  await expect(submitVideo(cfg, route, input())).rejects.toThrow(/缺少/);
  expect(spy).not.toHaveBeenCalled();
  const preflight = await preflightXhaiVideo(cfg, route, input());
  await expect(submitVideo(cfg, route, input(5), preflight)).rejects.toThrow(
    /缺少/,
  );
  expect(spy).toHaveBeenCalledTimes(2);
  await expect(
    submitVideo(cfg, route, input(), preflight),
  ).rejects.toMatchObject({ taskId: "adjusted-task", parameterMismatch: true });
  expect(spy).toHaveBeenCalledTimes(3);
});

it.each(["adjustment", "changed-price", "bad-duration", "ambiguous-lane"])(
  "does not invoke when the free estimate reports %s",
  async (mode) => {
    const cfg = config(),
      route = selectVideoRoute(cfg, cfg.defaultVideoSelection);
    const spy = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const value: any = estimate(!!body.pinned_lane_id, 4);
      if (mode === "adjustment")
        value.param_adjustments = [
          {
            param: "resolution",
            requested: "768p",
            applied: "2k",
            reason: "nearest_supported",
          },
        ];
      if (mode === "changed-price" && body.pinned_lane_id)
        Object.assign(value, {
          effective_total_rmb: 4,
          max_effective_total_rmb: 4,
          required_freeze_rmb: 4,
        });
      if (mode === "bad-duration") value.price_basis.output_duration_sec = 5;
      if (mode === "ambiguous-lane")
        value.channels.push({ lane: "second", is_delivery_head: true });
      return json(value);
    });
    vi.stubGlobal("fetch", spy);
    await expect(preflightXhaiVideo(cfg, route, input())).rejects.toThrow();
    expect(
      spy.mock.calls.every(
        ([url]) => new URL(String(url)).pathname === "/v1/pricing-estimate",
      ),
    ).toBe(true);
  },
);

it("never retries an uncertain paid invoke or submits after job cancellation", async () => {
  const cfg = config();
  stubProtocol();
  const prepared = await prepareAgentAi(cfg, imageBody(cfg));
  const spy = vi.fn(async () => {
    throw Error("socket closed after sending");
  });
  vi.stubGlobal("fetch", spy);
  await expect(submitAgentAi(cfg, prepared)).rejects.toThrow(/socket closed/);
  expect(spy).toHaveBeenCalledTimes(1);
  const abort = new AbortController();
  abort.abort();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      init.signal?.throwIfAborted();
      return json({ task_id: "must-not-submit" });
    }),
  );
  await expect(
    withJobSignal(abort.signal, () => submitAgentAi(cfg, prepared)),
  ).rejects.toThrow();
});

it("treats is_final as authoritative and records only the terminal receipt, never estimated price as actual cost", async () => {
  const cfg = config(),
    route = keyframeImageRoute(cfg);
  const recordAiReceipt = vi.fn(async () => {});
  const spy = vi
    .fn()
    .mockResolvedValueOnce(
      json({
        status: "completed",
        is_final: false,
        output_url: "https://assets.test/too-early.png",
      }),
    )
    .mockResolvedValueOnce(json({ status: "needs_review", is_final: false }))
    .mockResolvedValueOnce(
      json({
        status: "completed",
        is_final: true,
        output_url: "https://assets.test/final.png",
        result_url: "https://assets.test/wrong.png",
        actual_cost_micro_usd: 12500,
        effective_total_rmb: 2.5,
      }),
    );
  vi.stubGlobal("fetch", spy);
  const runtime = { ...cfg, recordAiReceipt };
  expect(await pollKeyframe(runtime, route, "task-1")).toMatchObject({
    pending: true,
  });
  expect(await pollKeyframe(runtime, route, "task-1")).toMatchObject({
    pending: true,
  });
  expect(recordAiReceipt).not.toHaveBeenCalled();
  expect(await pollKeyframe(runtime, route, "task-1")).toMatchObject({
    pending: false,
    url: "https://assets.test/final.png",
    cost: { actual_cost_micro_usd: 12500 },
  });
  expect(recordAiReceipt).toHaveBeenCalledWith(
    "aigc_image",
    "agentai.token6688.com",
    "gm-3-pro-image",
    expect.objectContaining({
      task_id: "task-1",
      actual_cost_micro_usd: 12500,
    }),
  );
  expect(
    spy.mock.calls.every(
      ([url, init]) =>
        new URL(url).pathname === "/v1/tasks/task-1" && init.method === "GET",
    ),
  ).toBe(true);
});

it("handles failed/expired/malformed task states without generation retry or invented zero charges", async () => {
  const cfg = config(),
    route = selectVideoRoute(cfg, cfg.defaultVideoSelection);
  const spy = vi
    .fn()
    .mockResolvedValueOnce(
      json({ status: "failed", is_final: true, error: "provider rejected" }),
    )
    .mockResolvedValueOnce(
      json({ status: "failed", is_final: true, error: "provider rejected" }),
    )
    .mockResolvedValueOnce(json({ message: "expired" }, 410))
    .mockResolvedValueOnce(json({ message: "retry status query" }, 503))
    .mockResolvedValueOnce(
      json({
        status: "completed",
        output_url: "https://assets.test/final.mp4",
      }),
    )
    .mockResolvedValueOnce(
      json({
        status: "completed",
        is_final: true,
        output_url: "https://assets.test/final.mp4",
        effective_total_rmb: 99,
      }),
    )
    .mockResolvedValueOnce(
      json({
        status: "completed",
        is_final: true,
        output_url: "http://assets.test/insecure.mp4",
      }),
    );
  vi.stubGlobal("fetch", spy);
  expect(await pollVideo(cfg, route, "task")).toMatchObject({
    pending: false,
    state: "failed",
  });
  await expect(
    pollAgentAi(cfg, "gm-3-pro-image", "image", "task"),
  ).rejects.toMatchObject({ terminal: true });
  expect(await pollVideo(cfg, route, "task")).toMatchObject({
    pending: false,
    state: "expired",
  });
  await expect(pollVideo(cfg, route, "task")).rejects.toThrow(/503/);
  await expect(pollVideo(cfg, route, "task")).rejects.toThrow(/终态/);
  expect(await pollVideo(cfg, route, "task")).toMatchObject({
    pending: false,
    state: "success",
    cost: undefined,
  });
  await expect(pollVideo(cfg, route, "task")).rejects.toThrow(/HTTPS/);
  expect(spy.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
});
