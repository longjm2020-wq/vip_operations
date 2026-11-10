vi.mock("../../apps/api/src/ai-model-routing.js", () => ({
  featureModelRef: async () => undefined,
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  catalog: vi.fn(),
  connected: null as string[] | null,
}));
vi.mock("../../apps/api/src/modules/workspace/agent-models.js", () => ({
  agentModelCandidates: f.catalog,
}));
vi.mock("../../apps/api/src/ai-model-connections.js", () => ({
  connectedModelRefs: async (models: { id: string }[]) =>
    new Set(f.connected ?? models.map((model) => model.id)),
}));
import {
  fallbackTeamModel,
  readTeamModelCatalog,
  resolveTeamModel,
  resolveTeamImageModel,
} from "../../apps/api/src/modules/workspace/team-models.js";
import type { AgentInternalModel } from "../../apps/api/src/modules/workspace/agent-models.js";

const models = [
  {
    id: "engine/strong",
    actual: "openai/gpt-6.1-sol",
    name: "通用助手",
    vision: true,
    pdf: true,
    structured: true,
    parameters: ["tools"],
  },
  {
    id: "engine/fast",
    actual: "deepseek/flash-quick",
    name: "快速问答",
    vision: false,
    pdf: false,
    structured: true,
    reasoningEffort: "none",
    parameters: ["tools"],
  },
  {
    id: "engine/standard",
    actual: "qwen/balanced",
    name: "中文助手",
    vision: true,
    pdf: false,
    structured: true,
    parameters: ["tools"],
  },
];
beforeEach(() => {
  f.connected = null;
  f.catalog.mockReset().mockResolvedValue({
    models,
    defaultModel: models[0].id,
    imageModels: [
      {
        id: "engine/image",
        actual: "image/model",
        name: "图像创作",
        reference: true,
        aspects: ["1:1"],
      },
      {
        id: "engine/plain-image",
        actual: "image/plain",
        name: "图像创作2",
        reference: false,
        aspects: ["1:1"],
      },
    ],
  });
});
describe("team model routing", () => {
  it("honors task override before member fixed selection, without silently replacing unavailable or incompatible fixed models", async () => {
    expect(
      await resolveTeamModel({
        taskModel: "engine/fast",
        profileModel: "engine/strong",
        orchestrator: true,
      }),
    ).toMatchObject({ id: "engine/fast", selectionReason: "本次任务指定模型" });
    expect(
      await resolveTeamModel({
        profileModel: "engine/standard",
        difficulty: "complex",
      }),
    ).toMatchObject({ id: "engine/standard", selectionReason: "成员固定模型" });
    await expect(
      resolveTeamModel({ taskModel: "engine/missing" }),
    ).rejects.toMatchObject({
      response: { error: { code: "TEAM_MODEL_UNAVAILABLE" } },
    });
    await expect(
      resolveTeamModel({ taskModel: "engine/fast", vision: true }),
    ).rejects.toMatchObject({
      response: { error: { code: "TEAM_MODEL_CAPABILITY" } },
    });
    await expect(
      resolveTeamModel({ taskModel: "engine/standard", pdf: true }),
    ).rejects.toMatchObject({
      response: { error: { code: "TEAM_MODEL_CAPABILITY" } },
    });
  });
  it("matches simple/standard/complex tasks by capability, while auto orchestrator prefers strong", async () => {
    expect((await resolveTeamModel({ difficulty: "simple" })).id).toBe(
      "engine/fast",
    );
    expect((await resolveTeamModel({ difficulty: "standard" })).id).toBe(
      "engine/standard",
    );
    expect((await resolveTeamModel({ difficulty: "complex" })).id).toBe(
      "engine/strong",
    );
    expect(
      (await resolveTeamModel({ difficulty: "simple", orchestrator: true })).id,
    ).toBe("engine/strong");
    expect(
      await resolveTeamModel({ difficulty: "simple", pdf: true }),
    ).toMatchObject({
      id: "engine/strong",
      selectionReason: expect.stringContaining("自动选择"),
    });
  });
  it("rejects an empty compatible catalog rather than sending unsupported media", async () => {
    f.catalog.mockResolvedValue({
      models: [models[1]],
      imageModels: [],
      defaultModel: models[1].id,
    });
    await expect(resolveTeamModel({ vision: true })).rejects.toMatchObject({
      response: { error: { code: "TEAM_MODEL_UNAVAILABLE" } },
    });
  });
  it("prefers an explicit quick profile of the same automatic simple model without changing a fixed profile", async () => {
    const normal = {
      ...models[0],
      id: "engine/deepseek-normal",
      actual: "deepseek/deepseek-v4.1-flash-1017",
      name: "深度思考",
      parameters: ["tools", "reasoning", "tool_choice"],
    };
    const quick = {
      ...normal,
      id: "engine/deepseek-quick",
      name: "快速问答",
      reasoningEffort: "none",
    };
    const unrelatedQuick = {
      ...quick,
      id: "engine/other-quick",
      actual: "google/gemini-flash",
    };
    f.catalog.mockResolvedValue({
      models: [models[0], normal, unrelatedQuick, quick],
      defaultModel: models[0].id,
      imageModels: [],
    });
    expect(await resolveTeamModel({ difficulty: "simple" })).toMatchObject({
      id: quick.id,
      actual: normal.actual,
      reasoningEffort: "none",
      selectionReason: expect.stringContaining("同型号已配置的快速模式"),
    });
    const fixed = await resolveTeamModel({
      taskModel: normal.id,
      difficulty: "simple",
    });
    expect(fixed).toMatchObject({ id: normal.id, actual: normal.actual });
    expect(fixed).not.toHaveProperty("reasoningEffort");
    expect(
      await resolveTeamModel({ profileModel: quick.id, difficulty: "complex" }),
    ).toMatchObject({ id: quick.id, reasoningEffort: "none" });
    expect(
      await resolveTeamModel({ orchestrator: true, difficulty: "simple" }),
    ).toMatchObject({ id: models[0].id });
    expect(normal).not.toHaveProperty("reasoningEffort");
  });
  it("keeps the original automatic model profile when its quick profile lacks required input capability", async () => {
    const normal = {
      ...models[0],
      id: "engine/flash-normal",
      actual: "deepseek/deepseek-v4.1-flash-1017",
      parameters: ["tools", "reasoning", "tool_choice"],
    };
    f.catalog.mockResolvedValue({
      models: [
        normal,
        {
          ...normal,
          id: "engine/flash-quick",
          reasoningEffort: "none",
          vision: false,
        },
      ],
      defaultModel: normal.id,
      imageModels: [],
    });
    const selected = await resolveTeamModel({
      difficulty: "simple",
      vision: true,
    });
    expect(selected).toMatchObject({ id: normal.id });
    expect(selected).not.toHaveProperty("reasoningEffort");
  });
  it("excludes explicit asynchronous models and retains catalog order instead of hash order within a tier", async () => {
    const batch = {
      ...models[1],
      id: "engine/000-batch",
      actual: "google/gemini-4-argon:batch",
    };
    const preferred = { ...models[1], id: "engine/zzz-preferred" };
    const later = { ...models[1], id: "engine/aaa-later" };
    f.catalog.mockResolvedValue({
      models: [batch, preferred, later, models[0]],
      defaultModel: later.id,
      imageModels: [],
    });
    expect(await resolveTeamModel({ difficulty: "simple" })).toMatchObject({
      id: preferred.id,
    });
    expect(
      (await readTeamModelCatalog()).models.map((item) => item.id),
    ).toEqual([preferred.id, later.id, models[0].id]);
    await expect(
      resolveTeamModel({ taskModel: batch.id }),
    ).rejects.toMatchObject({
      response: { error: { code: "TEAM_MODEL_CAPABILITY" } },
    });
    await expect(
      resolveTeamModel({ profileModel: batch.id }),
    ).rejects.toMatchObject({
      response: { error: { code: "TEAM_MODEL_CAPABILITY" } },
    });
    expect(
      await resolveTeamModel({
        taskModel: later.id,
        profileModel: preferred.id,
      }),
    ).toMatchObject({ id: later.id, selectionReason: "本次任务指定模型" });
  });
  it.each([":batch", ":BATCH", ":batch:free", ":async", ":asynchronous"])(
    "rejects an asynchronous-only catalog (%s) before a provider call",
    async (mode) => {
      f.catalog.mockResolvedValue({
        models: [{ ...models[1], actual: "provider/model" + mode }],
        imageModels: [],
        defaultModel: models[1].id,
      });
      await expect(resolveTeamModel({})).rejects.toMatchObject({
        response: { error: { code: "TEAM_MODEL_UNAVAILABLE" } },
      });
      await expect(
        resolveTeamModel({ profileModel: models[1].id }),
      ).rejects.toMatchObject({
        response: { error: { code: "TEAM_MODEL_CAPABILITY" } },
      });
    },
  );
  it("shows actual team model names without changing the opaque selected ids", async () => {
    const catalog = await readTeamModelCatalog();
    expect(catalog.models[0]).toMatchObject({
      id: "engine/strong",
      name: "通用助手",
      model: "openai/gpt-6.1-sol",
      tier: "strong",
    });
    expect(catalog.models[0]).not.toHaveProperty("actual");
    expect(catalog.notice).toContain("不代表全球模型排名");
  });
  it("does not substitute an incompatible fixed image model for a reference edit", async () => {
    await expect(
      resolveTeamImageModel({
        profileImageModel: "engine/plain-image",
        reference: true,
      }),
    ).rejects.toMatchObject({
      response: { error: { code: "TEAM_IMAGE_MODEL_CAPABILITY" } },
    });
    expect(await resolveTeamImageModel({ reference: true })).toMatchObject({
      id: "engine/image",
    });
    expect(
      await resolveTeamImageModel({
        taskImageModel: "engine/image",
        profileImageModel: "engine/plain-image",
      }),
    ).toMatchObject({
      id: "engine/image",
      selectionReason: "本次任务指定图像模型",
    });
  });
  it("selects an automatic image model that supports the requested aspect but never replaces a fixed one", async () => {
    f.catalog.mockResolvedValue({
      models,
      defaultModel: models[0].id,
      imageModels: [
        {
          id: "engine/square",
          actual: "image/square",
          name: "方图",
          reference: true,
          aspects: ["1:1"],
        },
        {
          id: "engine/portrait",
          actual: "image/portrait",
          name: "竖图",
          reference: true,
          aspects: ["9:16"],
        },
      ],
    });
    expect(
      await resolveTeamImageModel({ reference: true, aspectRatio: "9:16" }),
    ).toMatchObject({ id: "engine/portrait" });
    await expect(
      resolveTeamImageModel({
        profileImageModel: "engine/square",
        aspectRatio: "9:16",
      }),
    ).rejects.toMatchObject({
      response: { error: { code: "TEAM_IMAGE_MODEL_CAPABILITY" } },
    });
  });
  it("falls back from a disconnected default or fixed team model and records a visible notice", async () => {
    f.connected = ["engine/standard"];
    const fallback = await resolveTeamModel({
      profileModel: "engine/strong",
      orchestrator: true,
    });
    expect(fallback).toMatchObject({
      id: "engine/standard",
      selectionReason: expect.stringContaining("已自动切换到 中文助手"),
    });
    expect(fallback.selectionReason).toContain("未接通");
    expect(await resolveTeamModel({ difficulty: "complex" })).toMatchObject({
      id: "engine/standard",
    });
  });
  it("selects the next connected eligible model after an access error", async () => {
    f.connected = ["engine/strong", "engine/standard"];
    expect(
      await fallbackTeamModel(models[0] as AgentInternalModel, {
        structured: true,
        vision: true,
      }),
    ).toMatchObject({
      id: "engine/standard",
      selectionReason: expect.stringContaining("已自动切换到 中文助手"),
    });
  });
  it("does not replace an explicit model that is connected but lacks required capability", async () => {
    f.connected = ["engine/fast", "engine/standard"];
    await expect(
      resolveTeamModel({ taskModel: "engine/fast", vision: true }),
    ).rejects.toMatchObject({
      response: { error: { code: "TEAM_MODEL_CAPABILITY" } },
    });
  });
});
