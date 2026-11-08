import { bailianChatModel } from "../../../../../packages/contracts/src/bailian-chat.js";
import { createHash } from "node:crypto";
import type {
  AgentCatalog,
  AgentModel,
} from "../../../../../packages/contracts/src/assistant-agent.js";
import type { Row } from "../../../../../packages/database/src/index.js";
import { fail } from "../../core.js";
import { COMPASS_AI_MODEL } from "../../ai-model-constants.js";
import { featureModelRef } from "../../ai-model-routing.js";
import { connectedModelRefs } from "../../ai-model-connections.js";
import {
  aiFeatures,
  type AiFeatureId,
} from "../../../../../packages/contracts/src/ai-management.js";

export const modelRef = (id: string) =>
  "engine/" + createHash("sha256").update(id).digest("hex").slice(0, 24);
const flashModel = "deepseek/deepseek-v4.1-flash-1017";
const flashCanonicalModel = "deepseek/deepseek-v4.1-flash-20261017";
export type AgentInternalModel = AgentModel & {
  actual: string;
  provider?: "bailian";
  reasoningEffort?: "none";
};
type Model = AgentInternalModel;
export type AgentInternalImageModel = AgentCatalog["imageModels"][number] & {
  actual: string;
  aspects: string[];
};
type ImageModel = AgentInternalImageModel;
const primary: Model = {
  id: modelRef(COMPASS_AI_MODEL),
  actual: COMPASS_AI_MODEL,
  name: "通用助手",
  displayName: COMPASS_AI_MODEL.split("/").at(-1),
  vision: true,
  pdf: true,
  structured: true,
  parameters: ["tools", "structured_outputs", "reasoning"],
};
const bailian: Model = {
  id: modelRef("bailian/" + bailianChatModel),
  actual: bailianChatModel,
  provider: "bailian",
  name: "快速问答",
  displayName: "DeepSeek V4.1 Flash · 百炼",
  chatOnly: true,
  vision: true,
  pdf: false,
  structured: false,
  parameters: ["tools", "tool_choice", "response_format"],
};
let cached:
  { until: number; models: Model[]; imageModels: ImageModel[] } | undefined;
let loading: Promise<NonNullable<typeof cached>> | undefined;
function chatModel(m: Row, name: string): Model {
  return {
    id: modelRef(m.id),
    actual: m.id,
    name,
    displayName: modelDisplayName(m),
    vision: m.architecture.input_modalities?.includes("image") || false,
    pdf: m.architecture.input_modalities?.includes("file") || false,
    structured: m.supported_parameters.includes("structured_outputs"),
    parameters: m.supported_parameters,
  };
}
function modelDisplayName(m: Row): string {
  return (
    typeof m.name === "string" && m.name.trim()
      ? m.name.trim().replace(/^[^:]{1,40}:\s*/, "")
      : String(m.id).split("/").at(-1) || "默认模型"
  ).slice(0, 100);
}
export function matchesAgentModel(model: Model, returnedModel: unknown) {
  return (
    returnedModel === model.actual ||
    (model.actual === flashModel && returnedModel === flashCanonicalModel)
  );
}
async function discover(path: string): Promise<Row[]> {
  const response = await fetch("https://openrouter.ai/api/v1/" + path, {
    signal: AbortSignal.timeout(12000),
    redirect: "error",
  });
  if (!response.ok) throw Error("服务列表暂不可用");
  const payload = await response.json();
  if (!Array.isArray(payload.data)) throw Error("服务列表无效");
  return payload.data;
}
async function catalog() {
  if (cached && cached.until > Date.now()) return cached;
  if (!loading)
    loading = (async () => {
      const [chat, images] = await Promise.allSettled([
        discover("models"),
        discover("images/models"),
      ]);
      const models: Model[] = [primary, bailian];
      if (chat.status === "fulfilled") {
        const current = chat.value.find((m) => m.id === primary.actual);
        if (current)
          models[0] = { ...primary, displayName: modelDisplayName(current) };
        const candidates = chat.value
          .filter(
            (m) =>
              typeof m.id === "string" &&
              Array.isArray(m.supported_parameters) &&
              m.supported_parameters.includes("tools") &&
              Array.isArray(m.architecture?.input_modalities) &&
              m.architecture.input_modalities.includes("text") &&
              m.architecture.input_modalities.includes("image") &&
              Array.isArray(m.architecture?.output_modalities) &&
              m.architecture.output_modalities.includes("text") &&
              !/(?:^|:)(?:batch|async|asynchronous)(?=:|$)/i.test(m.id) &&
              !/(:free|:extended|:thinking|:online)$/.test(m.id),
          )
          .sort((a, b) => (b.created || 0) - (a.created || 0));
        // Only multimodal chat models enter the shared chat, team and management catalog.
        const groups = [
          { prefix: "deepseek/", label: "深度思考", count: 2 },
          { prefix: "openai/", label: "全能助手", count: 2 },
          { prefix: "google/", label: "视觉理解", count: 2 },
          { prefix: "anthropic/", label: "长文协作", count: 1 },
          { prefix: "qwen/", label: "中文助手", count: 1 },
        ];
        for (const group of groups) {
          const list = candidates
            .filter(
              (m) => m.id.startsWith(group.prefix) && m.id !== COMPASS_AI_MODEL,
            )
            .slice(0, group.count);
          list.forEach((m, i) =>
            models.push(chatModel(m, group.label + (i ? " · 备选" : ""))),
          );
        }
        const flash = candidates.find(
          (m) =>
            m.id === flashModel &&
            m.supported_parameters.includes("reasoning") &&
            m.supported_parameters.includes("tool_choice"),
        );
        if (flash)
          models.push({
            ...chatModel(flash, "快速问答"),
            id: modelRef(`${flashModel}:quick`),
            reasoningEffort: "none",
            displayName: modelDisplayName(flash) + " · 快速",
          });
      }
      const imageModels: ImageModel[] =
        images.status === "fulfilled"
          ? images.value
              .filter(
                (m) =>
                  typeof m.id === "string" &&
                  m.architecture?.output_modalities?.includes("image") &&
                  !/vector/i.test(m.id),
              )
              .sort(
                (a, b) =>
                  Number(b.id.startsWith("openai/")) -
                    Number(a.id.startsWith("openai/")) ||
                  (b.created || 0) - (a.created || 0),
              )
              .slice(0, 6)
              .map((m, i) => ({
                id: modelRef(m.id),
                actual: m.id,
                name: i ? `图像创作 ${i + 1}` : "图像创作",
                reference:
                  m.architecture.input_modalities?.includes("image") || false,
                aspects: m.supported_parameters?.aspect_ratio?.values || [
                  "1:1",
                ],
              }))
          : [];
      cached = {
        until:
          Date.now() +
          (chat.status === "fulfilled" && images.status === "fulfilled"
            ? 600000
            : 30000),
        models,
        imageModels,
      };
      return cached;
    })().finally(() => {
      loading = undefined;
    });
  return loading;
}
export async function publicAgentCatalog(): Promise<AgentCatalog> {
  const data = await catalog();
  const connected = await connectedModelRefs(data.models);
  const models = data.models.filter((model) => connected.has(model.id));
  return {
    models: models.map(
      ({
        actual: _actual,
        provider: _provider,
        reasoningEffort: _reasoningEffort,
        ...m
      }) => m,
    ),
    imageModels: data.imageModels.map(
      ({ actual: _actual, aspects: _aspects, ...m }) => m,
    ),
    defaultModel: (await featureModelRef("assistant_chat")) || primary.id,
    notice: models.length
      ? "仅显示当前连接最近调用成功的多模态模型。"
      : "暂无已接通的多模态模型，请在 AI 模型管理中检查连接。",
  };
}
/** Full routing metadata remains available to administrators for configuration. */
export async function agentModelCandidates() {
  const data = await catalog();
  return {
    models: data.models.map((model) => ({ ...model })),
    imageModels: data.imageModels.map((model) => ({ ...model })),
    defaultModel: primary.id,
  };
}
export async function resolveAgentModel(
  ref?: string,
  feature: AiFeatureId = "assistant_chat",
) {
  ref ||= await featureModelRef(feature);
  if (!ref || ref === primary.id) return primary;
  const model = (await catalog()).models.find((m) => m.id === ref);
  if (!model)
    fail(
      "MODEL_UNAVAILABLE",
      "所选模型不可用或不支持多模态对话，请刷新模型列表后重新选择",
      400,
    );
  if (model.provider === "bailian" && feature !== "assistant_chat")
    fail(
      "AI_MODEL_CAPABILITY",
      "此百炼模型用于网站内聊天，请为当前功能选择其他已接通模型",
      409,
    );
  return model;
}
export async function resolveFeatureModel(feature: AiFeatureId) {
  const model = await resolveAgentModel(undefined, feature);
  const kind = aiFeatures.find((item) => item.id === feature)?.kind;
  if (
    (kind === "vision" ||
      kind === "vision_structured" ||
      kind === "aigc_compile") &&
    !model.vision
  )
    fail(
      "AI_MODEL_CAPABILITY",
      "当前功能需要支持图片输入的模型，请在 AI 模型管理中重新选择",
      409,
    );
  if (
    (kind === "structured" || kind === "vision_structured") &&
    !model.structured
  )
    fail(
      "AI_MODEL_CAPABILITY",
      "当前功能需要结构化输出，请在 AI 模型管理中重新选择",
      409,
    );
  return model;
}
export async function resolveImageModel(ref?: string) {
  ref ||= await featureModelRef("assistant_image");
  const model = (await catalog()).imageModels.find((m) =>
    ref ? m.id === ref : true,
  );
  if (!model)
    fail("IMAGE_UNAVAILABLE", "图像服务暂不可用，请稍后刷新服务列表", 503);
  return model;
}
