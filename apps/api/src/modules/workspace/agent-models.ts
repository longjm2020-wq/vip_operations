import { createHash } from "node:crypto";
import type {
  AgentCatalog,
  AgentModel,
} from "../../../../../packages/contracts/src/assistant-agent.js";
import type { Row } from "../../../../../packages/database/src/index.js";
import { fail } from "../../core.js";
import { COMPASS_AI_MODEL } from "../analytics/ai.js";

export const modelRef = (id: string) =>
  "engine/" + createHash("sha256").update(id).digest("hex").slice(0, 24);
const flashModel = "deepseek/deepseek-v4.1-flash-1017";
const flashCanonicalModel = "deepseek/deepseek-v4.1-flash-20261017";
type Model = AgentModel & { actual: string; reasoningEffort?: "none" };
type ImageModel = AgentCatalog["imageModels"][number] & {
  actual: string;
  aspects: string[];
};
const primary: Model = {
  id: modelRef(COMPASS_AI_MODEL),
  actual: COMPASS_AI_MODEL,
  name: "通用助手",
  vision: true,
  pdf: true,
  structured: true,
  parameters: ["tools", "structured_outputs", "reasoning"],
};
let cached:
  { until: number; models: Model[]; imageModels: ImageModel[] } | undefined;
let loading: Promise<NonNullable<typeof cached>> | undefined;
function chatModel(m: Row, name: string): Model {
  return {
    id: modelRef(m.id),
    actual: m.id,
    name,
    vision: m.architecture.input_modalities?.includes("image") || false,
    pdf: m.architecture.input_modalities?.includes("file") || false,
    structured: m.supported_parameters.includes("structured_outputs"),
    parameters: m.supported_parameters,
  };
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
      const models: Model[] = [primary];
      if (chat.status === "fulfilled") {
        const candidates = chat.value
          .filter(
            (m) =>
              typeof m.id === "string" &&
              m.supported_parameters?.includes("tools") &&
              m.architecture?.output_modalities?.includes("text") &&
              !/(:free|:extended|:thinking|:online)$/.test(m.id),
          )
          .sort((a, b) => (b.created || 0) - (a.created || 0));
        // A small capability menu, with providers retained only on the server.
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
  return {
    models: data.models.map(
      ({ actual: _actual, reasoningEffort: _reasoningEffort, ...m }) => m,
    ),
    imageModels: data.imageModels.map(
      ({ actual: _actual, aspects: _aspects, ...m }) => m,
    ),
    defaultModel: primary.id,
    notice:
      data.models.length === 1
        ? "服务列表暂未完整加载，可继续使用通用助手。"
        : "",
  };
}
export async function resolveAgentModel(ref?: string) {
  if (!ref || ref === primary.id) return primary;
  const model = (await catalog()).models.find((m) => m.id === ref);
  if (!model)
    fail(
      "MODEL_UNAVAILABLE",
      "所选能力暂不可用，请刷新服务列表后重新选择",
      400,
    );
  return model;
}
export async function resolveImageModel(ref?: string) {
  const model = (await catalog()).imageModels.find((m) =>
    ref ? m.id === ref : true,
  );
  if (!model)
    fail("IMAGE_UNAVAILABLE", "图像服务暂不可用，请稍后刷新服务列表", 503);
  return model;
}
