import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock("../../apps/api/src/modules/workspace/agent-models.js", () => ({
  agentModelCandidates: f.catalog,
}));
import {
  readTeamModelCatalog,
  resolveTeamModel,
  resolveTeamImageModel,
} from "../../apps/api/src/modules/workspace/team-models.js";

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
beforeEach(() =>
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
  }),
);
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
});
