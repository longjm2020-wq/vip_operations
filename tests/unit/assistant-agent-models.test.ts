vi.mock("../../apps/api/src/ai-model-routing.js", () => ({ featureModelRef: async () => undefined }));
import { afterEach, expect, it, vi } from "vitest";
import {
  publicAgentCatalog,
  resolveAgentModel,
  resolveImageModel,
  modelRef,
} from "../../apps/api/src/modules/workspace/agent-models.js";
import { assistantPublicText } from "../../packages/contracts/src/ai-presentation.js";
afterEach(() => vi.unstubAllGlobals());
it("publishes model display names while routing opaque selections to the exact provider model", async () => {
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
                    created: 1,
                    architecture: {
                      input_modalities: ["text", "image"],
                      output_modalities: ["text"],
                    },
                    supported_parameters: ["tools", "structured_outputs"],
                  },
                  ...["batch", "async", "asynchronous"].map((mode) => ({
                    id: `deepseek/newest:${mode}`,
                    name: "Asynchronous model",
                    created: 100,
                    architecture: {
                      input_modalities: ["text"],
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
  expect(catalog.models.find((m) => m.name === "深度思考")).toMatchObject({
    vision: false,
    id: modelRef("deepseek/deepseek-v3.2"),
    displayName: "DeepSeek V3.2",
  });
  expect(
    (await resolveAgentModel(modelRef("deepseek/deepseek-v3.2"))).actual,
  ).toBe("deepseek/deepseek-v3.2");
  expect((await resolveImageModel()).aspects).toContain("16:9");
  await expect(resolveAgentModel("engine/unknown")).rejects.toThrow();
  expect(
    assistantPublicText("GPT语音、openai/gpt-6.1-sol、OpenRouter和DeepSeek"),
  ).not.toMatch(/gpt|openai|openrouter|deepseek/i);
});
