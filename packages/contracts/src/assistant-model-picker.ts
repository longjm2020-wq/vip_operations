import type { AgentCatalog } from "./assistant-agent.js";

export function visibleAssistantModels(catalog?: AgentCatalog) {
  return (
    catalog?.models?.filter(
      (model) =>
        model.vision === true ||
        (model.id.startsWith("agentai/") && !!model.chatVerifiedAt),
    ) || []
  );
}

export function resolveAssistantModelPickerState({
  catalog,
  value,
  teamSelected,
}: {
  catalog?: AgentCatalog;
  value?: string;
  teamSelected?: boolean;
}) {
  const models = visibleAssistantModels(catalog);
  const preferredId = teamSelected ? "team" : value || catalog?.defaultModel;
  const explicitAgentAi = preferredId?.startsWith("agentai/");
  const selected = teamSelected
    ? undefined
    : models.find((model) => model.id === preferredId) ||
      (explicitAgentAi ? undefined : models[0]);
  const selectedId = teamSelected ? "team" : selected?.id;
  const autoSwitched =
    !teamSelected && !!preferredId && !!selected && selected.id !== preferredId;
  const title = teamSelected
    ? "智能体团队"
    : selected?.displayName ||
      selected?.name ||
      (explicitAgentAi
        ? "所选 AgentAI 型号不可用"
        : models.length
          ? "默认模型"
          : preferredId
            ? "所选模型不可用"
            : "默认模型");
  const hint =
    explicitAgentAi && !selected
      ? "所选 AgentAI 型号尚未接通或验证已失效，请验证连接或重新选择；未自动切换线路。"
      : autoSwitched
        ? `已自动切换到 ${selected?.displayName || selected?.name}（原默认模型未接通）`
        : catalog?.fallbackNotice || "";
  return { models, selectedId, selected, title, autoSwitched, hint };
}
