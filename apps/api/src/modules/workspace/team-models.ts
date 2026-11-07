import { fail } from "../../core.js";
import type { TeamDifficulty } from "../../../../../packages/contracts/src/assistant-team.js";
import {
  agentModelCandidates,
  type AgentInternalModel,
} from "./agent-models.js";

export type TeamModelTier = "fast" | "standard" | "strong";

/** Explicit endpoint modes are not interchangeable with synchronous Chat calls. */
function supportsSynchronousTeamChat(model: AgentInternalModel): boolean {
  return !/(?:^|:)(?:batch|async|asynchronous)(?=:|$)/i.test(model.actual);
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
      "自动选型只在当前可用目录内按任务难度和能力匹配；主智能体默认优先较强能力，不代表全球模型排名。固定型号不可用时会暂停，不会悄悄切换。",
  };
}

export async function resolveTeamModel(options: {
  taskModel?: string;
  profileModel?: string;
  difficulty?: TeamDifficulty;
  orchestrator?: boolean;
  vision?: boolean;
  pdf?: boolean;
  structured?: boolean;
}) {
  const catalog = await agentModelCandidates();
  const fixed = options.taskModel || options.profileModel;
  const matches = (model: AgentInternalModel) =>
    supportsSynchronousTeamChat(model) &&
    model.parameters.includes("tools") &&
    (!options.vision || model.vision) &&
    (!options.pdf || model.pdf) &&
    (!options.structured || model.structured);
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
    return {
      ...model,
      tier: teamModelTier(model),
      selectionReason: options.taskModel ? "本次任务指定模型" : "成员固定模型",
    };
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
    .filter(matches)
    .sort(
      (left, right) =>
        priorities.indexOf(teamModelTier(left)) -
        priorities.indexOf(teamModelTier(right)),
    );
  const model = available[0];
  if (!model)
    fail(
      "TEAM_MODEL_UNAVAILABLE",
      "当前模型目录没有满足本步骤能力要求的模型，请检查团队模型配置",
      409,
    );
  const tier = teamModelTier(model);
  return {
    ...model,
    tier,
    selectionReason:
      tier === desired
        ? `按${options.orchestrator ? "主智能体" : "任务"}的${desired}能力偏好自动匹配`
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
