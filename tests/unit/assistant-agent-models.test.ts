vi.mock("../../apps/api/src/ai-model-routing.js", () => ({
  featureModelRef: async () => undefined,
}));
const connections = vi.hoisted(() => ({ allowed: null as string[] | null }));
vi.mock("../../apps/api/src/ai-model-connections.js", () => ({
  connectedModelRefs: async (models: { id: string }[]) =>
    new Set(connections.allowed ?? models.map((model) => model.id)),
}));
import { afterEach, expect, it, vi } from "vitest";
import {
  publicAgentCatalog,
  resolveAgentModel,
  resolveImageModel,
  modelRef,
} from "../../apps/api/src/modules/workspace/agent-models.js";
import { assistantPublicText } from "../../packages/contracts/src/ai-presentation.js";
afterEach(() => {
  vi.unstubAllGlobals();
  connections.allowed = null;
});
it("only offers multimodal chat models and routes eligible selections to the exact provider model", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify({
            data: url.endsWith("images/models")
              ? [
                  {
                    id: "openai/gpt-image-2",
                    architecture: {
                      input_modalities: ["text", "image"],
                      output_modalities: ["image"],
                    },
                    supported_parameters: {
                      aspect_ratio: { values: ["1:1", "16:9"] },
                    },
                  },
                ]
              : [
                  {
                    id: "deepseek/deepseek-v3.2",
                    name: "DeepSeek: DeepSeek V3.2",
                    created: 3,
                    architecture: {
                      input_modalities: ["text"],
                      output_modalities: ["text"],
                    },
                    supported_parameters: ["tools"],
                  },
                  {
                    id: "google/gemini-2.5-pro",
                    name: "Google: Gemini 2.5 Pro",
                    created: 1,
                    architecture: {
                      input_modalities: ["text", "image"],
                      output_modalities: ["text"],
                    },
                    supported_parameters: ["tools", "structured_outputs"],
                  },
                  ...[
                    {
                      id: "openai/text-only",
                      input: ["text"],
                      output: ["text"],
                    },
                    { id: "openai/unknown-input", output: ["text"] },
                    {
                      id: "google/image-only-input",
                      input: ["image"],
                      output: ["text"],
                    },
                    {
                      id: "google/image-only-output",
                      input: ["text", "image"],
                      output: ["image"],
                    },
                    {
                      id: "anthropic/malformed-input",
                      input: "text,image",
                      output: ["text"],
                    },
                    { id: "qwen/unknown-output", input: ["text", "image"] },
                    {
                      id: "deepseek/deepseek-v4.1-flash-1017",
                      input: ["text"],
                      output: ["text"],
                    },
                  ].map(({ id, input, output }) => ({
                    id,
                    created: 200,
                    architecture: {
                      input_modalities: input,
                      output_modalities: output,
                    },
                    supported_parameters: ["tools", "reasoning", "tool_choice"],
                  })),
                  ...["batch", "async", "asynchronous"].map((mode) => ({
                    id: `deepseek/newest:${mode}`,
                    name: "Asynchronous model",
                    created: 100,
                    architecture: {
                      input_modalities: ["text", "image"],
                      output_modalities: ["text"],
                    },
                    supported_parameters: ["tools"],
                  })),
                ],
          }),
        ),
    ),
  );
  const catalog = await publicAgentCatalog();
  expect(catalog.models.every((m) => m.id.startsWith("engine/"))).toBe(true);
  expect(catalog.models.every((m) => !Object.hasOwn(m, "actual"))).toBe(true);
  expect(
    catalog.models.some((m) => m.displayName === "Asynchronous model"),
  ).toBe(false);
  expect(catalog.models.every((m) => m.vision)).toBe(true);
  expect(catalog.models.map((m) => m.id)).toEqual([
    modelRef("openai/gpt-6.1-sol"),
    modelRef("bailian/deepseek-v4.1-flash-1017"),
    modelRef("google/gemini-2.5-pro"),
  ]);
  expect(catalog.models.find((m) => m.name === "视觉理解")).toMatchObject({
    vision: true,
    id: modelRef("google/gemini-2.5-pro"),
    displayName: "Gemini 2.5 Pro",
  });
  connections.allowed = [modelRef("google/gemini-2.5-pro")];
  const connectedCatalog = await publicAgentCatalog();
  expect(connectedCatalog.models.map((model) => model.id)).toEqual(
    connections.allowed,
  );
  // A disconnected default is never replaced silently with a different model.
  expect(connectedCatalog.defaultModel).toBe(modelRef("openai/gpt-6.1-sol"));
  connections.allowed = [];
  expect(await publicAgentCatalog()).toMatchObject({
    models: [],
    notice: expect.stringContaining("暂无已接通"),
  });
  expect(
    (await resolveAgentModel(modelRef("google/gemini-2.5-pro"))).actual,
  ).toBe("google/gemini-2.5-pro");
  await expect(
    resolveAgentModel(modelRef("deepseek/deepseek-v3.2")),
  ).rejects.toMatchObject({
    response: { error: { code: "MODEL_UNAVAILABLE" } },
  });
  await expect(
    resolveAgentModel(modelRef("deepseek/deepseek-v4.1-flash-1017:quick")),
  ).rejects.toMatchObject({
    response: { error: { code: "MODEL_UNAVAILABLE" } },
  });
  expect((await resolveImageModel()).aspects).toContain("16:9");
  await expect(resolveAgentModel("engine/unknown")).rejects.toThrow();
  expect(
    assistantPublicText("GPT语音、openai/gpt-6.1-sol、OpenRouter和DeepSeek"),
  ).not.toMatch(/gpt|openai|openrouter|deepseek/i);
});
