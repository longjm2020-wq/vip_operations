import type {
  AgentCatalog,
  AgentModel,
} from "../../../packages/contracts/src/assistant-agent.js";

type Purpose = "daily" | "analysis" | "vision" | "writing";
type PurposeOption = {
  value: Purpose | "current";
  label: string;
  model: string;
};

// Purpose labels route to existing catalog entries; they do not add capabilities
// or change a selected model when the catalog is refreshed.
export function assistantPurposeMenu(
  catalog: AgentCatalog | undefined,
  selectedModel?: string,
  preferredPurpose?: string,
): { options: PurposeOption[]; value: PurposeOption["value"] | undefined } {
  const models = catalog?.models || [];
  const named = (names: string[], eligible = (_model: AgentModel) => true) => {
    for (const name of names) {
      const model =
        models.find((m) => m.name === name && eligible(m)) ||
        models.find(
          (m) => m.name.replace(/\s*·\s*备选$/, "") === name && eligible(m),
        );
      if (model) return model;
    }
  };
  const daily =
    models.find((m) => m.id === catalog?.defaultModel) ||
    named(["通用助手"]) ||
    models[0];
  const analysis =
    named(["深度思考"]) ||
    models.find((m) => m.parameters?.includes("reasoning"));
  const vision =
    named(["视觉理解"], (m) => m.vision) ||
    (daily?.vision ? daily : models.find((m) => m.vision));
  const writing = named(["长文协作", "中文助手", "全能助手"]) || daily;
  const options: PurposeOption[] = [];
  const add = (
    value: Purpose,
    label: string,
    model: AgentModel | undefined,
  ) => {
    if (model) options.push({ value, label, model: model.id });
  };
  add("daily", "日常问答", daily);
  add("analysis", "深度分析", analysis);
  add("vision", "看图理解", vision);
  add("writing", "写作", writing);

  const currentModel = selectedModel || catalog?.defaultModel;
  const selected =
    options.find(
      (option) =>
        option.value === preferredPurpose && option.model === currentModel,
    ) || options.find((option) => option.model === currentModel);
  if (currentModel && !selected) {
    options.push({ value: "current", label: "当前选择", model: currentModel });
    return { options, value: "current" };
  }
  return { options, value: selected?.value };
}
