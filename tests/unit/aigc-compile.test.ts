import { expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createStudio } from "../../packages/aigc-engine/index.mjs";

it("reference compilation uses the configured model once, saves artifacts and waits for explicit video generation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aigc-compile-test-"));
  let snapshot: any;
  const engine = await createStudio({
    config: {
      dataDir: directory,
      videoSecrets: {},
      compileProvider: "openrouter",
      openrouterApiKey: "fixture-only",
      openrouterModel: "openai/gpt-6.1-sol",
      openrouterBaseUrl: "https://compile.test",
      compileMaxOutputTokens: 10000,
      compileRequestTimeoutMs: 5000,
      maxVideoSecondsPerProject: 30,
      maxClipSeconds: 15,
      maxGenerationSegments: 10,
      defaultClipSeconds: 6,
    },
    users: [
      {
        id: "1",
        username: "creator",
        displayName: "Creator",
        role: "super_admin",
      },
    ],
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
  engine.worker.wake = () => {};
  const image = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const model = await engine.store.putAsset({
    buffer: image,
    name: "人物.png",
    kind: "model",
    ownerId: "1",
    projectId: "project",
  });
  const product = await engine.store.putAsset({
    buffer: image,
    name: "商品.png",
    kind: "product",
    ownerId: "1",
    projectId: "project",
  });
  const template = await engine.store.putTextAsset({
    name: "C.json",
    text: JSON.stringify({ source_duration_s: 6 }),
    ownerId: "1",
    projectId: "project",
  });
  const timestamp = new Date().toISOString();
  await engine.store.mutate((data: any) =>
    data.appState.projects.push({
      id: "project",
      ownerId: "1",
      name: "新品短视频",
      status: "ready",
      createdAt: timestamp,
      updatedAt: timestamp,
      videoAspectRatio: "9:16",
      sceneMode: "reference",
      replicationMode: "complete",
      modelMeasurements: [],
      productMeasurements: [{ label: "衣长", value: "100", unit: "cm" }],
      assets: {
        modelImages: [model],
        productImages: [product],
        sceneImages: [],
        reusableTemplate: template,
      },
    }),
  );
  const action = "人物站立，双手握扇轻旋，再缓慢抬头。";
  const response = {
    id: "fixture_request",
    model: "openai/gpt-6.1-sol",
    status: "completed",
    output_text: JSON.stringify({
      schema: "XUTI_COMPILE_V1",
      units: [
        {
          id: "S01",
          duration_s: 6,
          camera: "中景胸像，略低机位，固定构图。",
          action,
          scene: "门外走廊明暗交界处。",
          grok_prompt: "展示当前商品的上身纹样，手中折扇不得遮挡领口。",
        },
      ],
      truth: {},
      qa: {},
      product_lock: [],
    }),
  };
  const provider = vi.fn(
    async (input: string | URL | Request, options?: RequestInit) => {
      expect(String(input)).toBe("https://compile.test/responses");
      expect(JSON.parse(String(options?.body)).model).toBe(
        "openai/gpt-6.1-sol",
      );
      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", provider);
  try {
    const task = await engine.worker.startCompile("project", undefined, {
      compileOnly: true,
    });
    await engine.worker.tick();
    const job = engine.store.getJob(task.id);
    expect(
      job.status,
      JSON.stringify(engine.store.data.appState.tasks[0]),
    ).toBe("completed");
    expect(job.payload.artifacts.units[0].shot_plan[0].action).toBe(action);
    expect(snapshot.jobs[task.id].status).toBe("completed");
    expect(
      engine.store.data.platform.requests[`${task.id}:compile`].state,
    ).toBe("captured");
    expect(
      Object.values<any>(engine.store.data.jobs).some(
        (j) => j.type === "generate",
      ),
    ).toBe(false);
    expect(provider).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
    engine.stop();
  }
});
