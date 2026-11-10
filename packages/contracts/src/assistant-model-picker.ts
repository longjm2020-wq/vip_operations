import type { AgentCatalog } from "./assistant-agent.js";

export function visibleAssistantModels(catalog?: AgentCatalog) {
  return catalog?.models?.filter((model) => model.vision === true) || [];
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
  const selected = teamSelected
    ? undefined
    : models.find((model) => model.id === preferredId) || models[0];
  const selectedId = teamSelected ? "team" : selected?.id;
  const autoSwitched =
    !teamSelected && !!preferredId && !!selected && selected.id !== preferredId;
  const title = teamSelected
    ? "智能体团队"
    : selected?.displayName ||
      selected?.name ||
      (models.length
        ? "默认模型"
        : preferredId
          ? "所选模型不可用"
          : "默认模型");
  const hint = autoSwitched
    ? `已自动切换到 ${selected?.displayName || selected?.name}（原默认模型未接通）`
    : catalog?.fallbackNotice || "";
  return { models, selectedId, selected, title, autoSwitched, hint };
}
