import { fail } from "../../core.js";
import { featureModelRef } from "../../ai-model-routing.js";
import type { TeamDifficulty } from "../../../../../packages/contracts/src/assistant-team.js";
import {
  agentModelCandidates,
  type AgentInternalModel,
} from "./agent-models.js";
import {
  firstEligibleConnected,
  modelFallbackNotice,
  publicModelLabel,
  safeConnectedModelRefs,
} from "./model-fallback.js";

export type TeamModelTier = "fast" | "standard" | "strong";

/** Explicit endpoint modes are not interchangeable with synchronous Chat calls. */
function supportsSynchronousTeamChat(model: AgentInternalModel): boolean {
  return (
    model.provider !== "bailian" &&
    !/(?:^|:)(?:batch|async|asynchronous)(?=:|$)/i.test(model.actual)
  );
}

/** A routing policy for the available configured catalog, not a global ranking. */
export function teamModelTier(model: AgentInternalModel): TeamModelTier {
  if (
    model.reasoningEffort === "none" ||
    /(?:flash|mini|nano|haiku|lite|small)(?:[-/:.]|$)/i.test(model.actual)
  )
    return "fast";
  if (
    /(?:gpt-6|gpt-5|opus|(?:^|[-/])pro(?:[-/.]|$)|qwen[^/]*max|deepseek-v[4-9])/i.test(
      model.actual,
    )
  )
    return "strong";
  return "standard";
}

async function connectedTeamModels(models: AgentInternalModel[]) {
  return safeConnectedModelRefs(models.filter(supportsSynchronousTeamChat));
}

export async function readTeamModelCatalog() {
  const catalog = await agentModelCandidates();
  return {
    models: catalog.models.filter(supportsSynchronousTeamChat).map((model) => ({
      id: model.id,
      name: model.name,
      model: model.actual,
      tier: teamModelTier(model),
      vision: model.vision,
      pdf: model.pdf,
      structured: model.structured,
      parameters: model.parameters,
    })),
    imageModels: catalog.imageModels.map((model) => ({
      id: model.id,
      name: model.name,
      model: model.actual,
      reference: model.reference,
      aspects: model.aspects,
    })),
    defaultModel: catalog.defaultModel,
    notice:
      "自动选型只在当前已接通目录内按任务难度和能力匹配；主智能体默认优先较强能力，不代表全球模型排名。固定或默认型号未接通，或调用返回认证、权限、额度类错误时，会自动改用一个已接通且满足本步骤能力的型号，并在执行详情中说明。百炼聊天型号仅用于网站内对话，不会用于团队。内容类错误不会换型号。",
  };
}

export async function resolveTeamModel(options: {
  feature?: "assistant_team" | "deerflow_team" | "mastra_team";
  taskModel?: string;
  profileModel?: string;
  difficulty?: TeamDifficulty;
  orchestrator?: boolean;
  vision?: boolean;
  pdf?: boolean;
  structured?: boolean;
}) {
  const catalog = await agentModelCandidates();
  const managed = await featureModelRef(options.feature || "assistant_team");
  const fixed = options.taskModel || options.profileModel || managed;
  const matches = (model: AgentInternalModel) =>
    supportsSynchronousTeamChat(model) &&
    model.parameters.includes("tools") &&
    (!options.vision || model.vision) &&
    (!options.pdf || model.pdf) &&
    (!options.structured || model.structured);
  const connected = await connectedTeamModels(catalog.models);
  const connectedMatch = (excluded: string[] = []) =>
    firstEligibleConnected(catalog.models, connected, matches, excluded);
  if (fixed) {
    const model = catalog.models.find((item) => item.id === fixed);
    if (!model)
      fail(
        "TEAM_MODEL_UNAVAILABLE",
        "指定的团队模型当前不可用，请更新模型选择后重新发起；未切换到其他模型",
        409,
      );
    if (!supportsSynchronousTeamChat(model))
      fail(
        "TEAM_MODEL_CAPABILITY",
        "指定型号仅用于批处理或异步调用，不支持团队当前的同步对话执行；未调用该型号，也未切换到其他模型",
        409,
      );
    if (!matches(model))
      fail(
        "TEAM_MODEL_CAPABILITY",
        "指定模型不支持本步骤需要的输入或结构化输出能力；未切换到其他模型",
        409,
      );
    if (!connected.size || connected.has(model.id))
      return {
        ...model,
        tier: teamModelTier(model),
        selectionReason: options.taskModel
          ? "本次任务指定模型"
          : options.profileModel
            ? "成员固定模型"
            : "AI 模型管理默认值",
      };
    const fallback = connectedMatch([model.id]);
    if (fallback)
      return {
        ...fallback,
        tier: teamModelTier(fallback),
        selectionReason: modelFallbackNotice(
          publicModelLabel(fallback),
          options.taskModel
            ? "本次任务指定模型未接通"
            : options.profileModel
              ? "成员固定模型未接通"
              : "AI 模型管理默认值未接通或最近一次调用未成功",
        ),
      };
    fail(
      "TEAM_MODEL_UNAVAILABLE",
      "指定的团队模型当前未接通，且没有其他已接通、满足本步骤能力的团队模型可改用。请检查 OpenRouter 连接后重新发起；百炼聊天型号不能用于团队",
      409,
    );
  }
  const desired = options.orchestrator
    ? "strong"
    : options.difficulty === "simple"
      ? "fast"
      : options.difficulty === "complex"
        ? "strong"
        : "standard";
  const priorities: TeamModelTier[] =
    desired === "fast"
      ? ["fast", "standard", "strong"]
      : desired === "strong"
        ? ["strong", "standard", "fast"]
        : ["standard", "strong", "fast"];
  // Stable sorting preserves the catalog's configured preference within a tier.
  // Opaque model IDs are identifiers, never a quality or priority ranking.
  const available = catalog.models
    .filter(
      (model) => matches(model) && (!connected.size || connected.has(model.id)),
    )
    .sort(
      (left, right) =>
        priorities.indexOf(teamModelTier(left)) -
        priorities.indexOf(teamModelTier(right)),
    );
  const preferred = available[0];
  // A "flash" model can expose both a normal reasoning profile and an explicit
  // quick profile. For simple work, prefer that configured profile of the same
  // actual model; never invent unsupported reasoning options or change providers.
  const model =
    desired === "fast" && preferred
      ? available.find(
          (candidate) =>
            candidate.actual === preferred.actual &&
            candidate.reasoningEffort === "none",
        ) || preferred
      : preferred;
  if (!model)
    fail(
      "TEAM_MODEL_UNAVAILABLE",
      connected.size
        ? "当前已接通模型没有满足本步骤能力要求的型号，请检查团队模型配置"
        : "当前没有已接通且满足本步骤能力要求的团队模型。请在 AI 模型管理中检查 OpenRouter 连接；百炼聊天型号不能用于团队",
      409,
    );
  const tier = teamModelTier(model);
  return {
    ...model,
    tier,
    selectionReason:
      tier === desired
        ? `按${options.orchestrator ? "主智能体" : "任务"}的${desired}能力偏好自动匹配${desired === "fast" && model.reasoningEffort === "none" ? "，使用同型号已配置的快速模式" : ""}`
        : `当前${desired}候选不可用，自动选择满足输入能力的${tier}候选`,
  };
}

export async function resolveTeamImageModel(options: {
  taskImageModel?: string;
  profileImageModel?: string;
  reference?: boolean;
  aspectRatio?: string;
}) {
  const { imageModels } = await agentModelCandidates();
  const fixed = options.taskImageModel || options.profileImageModel;
  const model = fixed
    ? imageModels.find((item) => item.id === fixed)
    : imageModels.find(
        (item) =>
          (!options.reference || item.reference) &&
          (!options.aspectRatio || item.aspects.includes(options.aspectRatio)),
      );
  if (!model)
    fail(
      "TEAM_IMAGE_MODEL_UNAVAILABLE",
      "图像模型当前不可用，请检查团队图像配置后重试",
      409,
    );
  if (
    (options.reference && !model.reference) ||
    (options.aspectRatio && !model.aspects.includes(options.aspectRatio))
  )
    fail(
      "TEAM_IMAGE_MODEL_CAPABILITY",
      "指定图像模型不支持本次参考图或画幅要求，未切换到其他模型",
      409,
    );
  return {
    ...model,
    selectionReason: fixed
      ? options.taskImageModel
        ? "本次任务指定图像模型"
        : "成员固定图像模型"
      : "按图像输入能力自动匹配",
  };
}

export async function fallbackTeamModel(
  current: AgentInternalModel,
  options: Parameters<typeof resolveTeamModel>[0],
) {
  const catalog = await agentModelCandidates();
  const connected = await connectedTeamModels(catalog.models);
  const fallback = firstEligibleConnected(
    catalog.models,
    connected,
    (model) =>
      supportsSynchronousTeamChat(model) &&
      model.parameters.includes("tools") &&
      (!options.vision || model.vision) &&
      (!options.pdf || model.pdf) &&
      (!options.structured || model.structured),
    [current.id],
  );
  if (!fallback) return undefined;
  return {
    ...fallback,
    tier: teamModelTier(fallback),
    selectionReason: modelFallbackNotice(
      publicModelLabel(fallback),
      "原模型访问被拒绝或额度不足",
    ),
  };
}
