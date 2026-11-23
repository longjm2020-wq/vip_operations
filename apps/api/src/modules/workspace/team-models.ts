import { fail } from "../../core.js";
import { featureModelRef } from "../../ai-model-routing.js";
import type { TeamDifficulty } from "../../../../../packages/contracts/src/assistant-team.js";
import type { EmployeeModelPolicy } from "../../../../../packages/contracts/src/assistant-employees.js";
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
import {
  smartRankImageModels,
  smartRankTeamModels,
} from "./smart-models.js";

export type TeamModelTier = "fast" | "standard" | "strong";

/** Explicit endpoint modes are not interchangeable with synchronous Chat calls. */
function supportsSynchronousTeamChat(model: AgentInternalModel): boolean {
  return (
    model.provider !== "bailian" &&
    (model.provider !== "agentai" ||
      (model.structured && model.parameters.includes("tools"))) &&
    (model.provider !== "relay" ||
      (model.structured && model.parameters.includes("tools"))) &&
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
      "员工按任务难度、输入类型与岗位配置选择工作模型。小序派单优先选择较强的规划模型。AgentAI 员工型号须通过工具和结构化输出验证。执行详情记录实际型号和共享连接的访问错误回退情况。",
  };
}

export async function resolveTeamModel(options: {
  policy?: EmployeeModelPolicy;
  taskModel?: string;
  profileModel?: string;
  difficulty?: TeamDifficulty;
  orchestrator?: boolean;
  vision?: boolean;
  pdf?: boolean;
  structured?: boolean;
}) {
  const catalog = await agentModelCandidates();
  const managed = await featureModelRef("assistant_employee");
  const policy = options.policy;
  const restricted = policy && policy.mode !== "auto";
  const fixed = restricted
    ? policy.mode === "fixed"
      ? policy.modelIds[0]
      : undefined
    : options.taskModel || options.profileModel || managed;
  const matches = (model: AgentInternalModel) =>
    supportsSynchronousTeamChat(model) &&
    (!restricted || policy.modelIds.includes(model.id)) &&
    model.parameters.includes("tools") &&
    (!options.vision || model.vision) &&
    (!options.pdf || model.pdf) &&
    (!options.structured || model.structured);
  const connected = await connectedTeamModels(catalog.models);
  const connectedMatch = (excluded: string[] = []) =>
    firstEligibleConnected(
      catalog.models,
      connected,
      (model) => matches(model) && model.provider !== "agentai",
      excluded,
    );
  if (fixed) {
    const model = catalog.models.find((item) => item.id === fixed);
    if (!model)
      fail(
        "TEAM_MODEL_UNAVAILABLE",
        "指定的员工模型当前不可用，请更新模型选择后重新发起任务",
        409,
      );
    if (!supportsSynchronousTeamChat(model))
      fail(
        "TEAM_MODEL_CAPABILITY",
        "员工需要支持同步对话和工具调用的工作模型，请检查所选型号",
        409,
      );
    if (!matches(model))
      fail(
        "TEAM_MODEL_CAPABILITY",
        "指定模型不支持本步骤需要的输入或结构化输出能力；未切换到其他模型",
        409,
      );
    if (
      (model.provider === "agentai" || model.provider === "relay") &&
      !connected.has(model.id)
    )
      fail(
        "TEAM_MODEL_UNAVAILABLE",
        "所选外部中转型号尚未通过当前连接的调用验证；未切换其他连接",
        409,
      );
    if (policy?.mode === "fixed" || !connected.size || connected.has(model.id))
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
      "此步骤缺少已接通且兼容的员工模型，请在 AI 模型管理中核对工作模型及连接",
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
  let available = catalog.models
    .filter(
      (model) =>
        matches(model) &&
        (connected.has(model.id) ||
          (!connected.size &&
            model.provider !== "agentai" &&
            model.provider !== "relay")),
    )
    .sort(
      (left, right) =>
        priorities.indexOf(teamModelTier(left)) -
        priorities.indexOf(teamModelTier(right)),
    );
  let smartReason: string | undefined;
  if (restricted && policy.mode === "fallback") {
    // Only catalog availability/capability can select a backup before submission.
    // Provider timeouts and uncertain media submissions never trigger a retry.
    available.sort(
      (a, b) => policy.modelIds.indexOf(a.id) - policy.modelIds.indexOf(b.id),
    );
  } else if (!restricted && available.length) {
    const smart = await smartRankTeamModels(available, {
      orchestrator: options.orchestrator,
      difficulty: options.difficulty,
    });
    const unshielded = smart.ranked.filter(
      (m) => !smart.shieldedIds.has(m.id) && !smart.shieldedIds.has(m.actual),
    );
    const pool = unshielded.length ? unshielded : smart.ranked;
    const rankIndex = new Map(smart.ranked.map((m, i) => [m.id, i]));
    available = [...pool].sort(
      (left, right) =>
        priorities.indexOf(teamModelTier(left)) -
          priorities.indexOf(teamModelTier(right)) ||
        (rankIndex.get(left.id) ?? 0) - (rankIndex.get(right.id) ?? 0),
    );
    if (available[0]) {
      smartReason = smart.reasons.get(available[0].id);
    }
  }
  const preferred = available[0];
  // A "flash" model can expose both a normal reasoning profile and an explicit
  // quick profile. For simple work, prefer that configured profile of the same
  // actual model; never invent unsupported reasoning options or change providers.
  const model =
    desired === "fast" && preferred
      ? available.find(
          (candidate) =>
            candidate.provider === preferred.provider &&
            candidate.actual === preferred.actual &&
            candidate.reasoningEffort === "none",
        ) || preferred
      : preferred;
  if (!model)
    fail(
      "TEAM_MODEL_UNAVAILABLE",
      connected.size
        ? "请在员工配置中选择满足本步骤能力要求的工作模型"
        : "当前缺少可用于此步骤的员工模型，请在 AI 模型管理中核对连接",
      409,
    );
  const tier = teamModelTier(model);
  return {
    ...model,
    tier,
    selectionReason: restricted
      ? `员工${policy.mode === "fallback" ? "主备顺序" : "限定候选"}：${model.name}`
      : tier === desired
        ? smartReason ||
          `按${options.orchestrator ? "主智能体" : "任务"}的${desired}能力偏好自动匹配${desired === "fast" && model.reasoningEffort === "none" ? "，使用同型号已配置的快速模式" : ""}`
        : `当前${desired}候选不可用，自动选择满足输入能力的${tier}候选`,
  };
}

export async function resolveTeamImageModel(options: {
  policy?: EmployeeModelPolicy;
  taskImageModel?: string;
  profileImageModel?: string;
  reference?: boolean;
  aspectRatio?: string;
}) {
  const { imageModels } = await agentModelCandidates();
  const policy = options.policy;
  const restricted = policy && policy.mode !== "auto";
  const fixed = restricted
    ? policy.mode === "fixed"
      ? policy.modelIds[0]
      : undefined
    : options.taskImageModel || options.profileImageModel;
  const rawCandidates = restricted
    ? policy.modelIds.flatMap((id) => imageModels.filter((m) => m.id === id))
    : imageModels;
  const candidates =
    !fixed && !restricted
      ? await smartRankImageModels(rawCandidates)
      : rawCandidates;
  const model = fixed
    ? imageModels.find((item) => item.id === fixed)
    : candidates.find(
        (item) =>
          (!options.reference || item.reference) &&
          (!options.aspectRatio || item.aspects.includes(options.aspectRatio)),
      );
  if (!model)
    fail(
      "TEAM_IMAGE_MODEL_UNAVAILABLE",
      "图像模型当前不可用，请检查员工图像模型配置后重试",
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
  excluded: string[] = [current.id],
) {
  if (options.policy?.mode === "fixed" || current.provider === "agentai")
    return undefined;
  const catalog = await agentModelCandidates();
  const connected = await connectedTeamModels(catalog.models);
  const fallback = firstEligibleConnected(
    options.policy && options.policy.mode !== "auto"
      ? options.policy.modelIds.flatMap((id) =>
          catalog.models.filter((m) => m.id === id),
        )
      : catalog.models,
    connected,
    (model) =>
      supportsSynchronousTeamChat(model) &&
      model.provider === current.provider &&
      model.parameters.includes("tools") &&
      (!options.vision || model.vision) &&
      (!options.pdf || model.pdf) &&
      (!options.structured || model.structured),
    excluded,
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
