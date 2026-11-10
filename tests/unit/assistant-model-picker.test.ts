import { describe, expect, it } from "vitest";
import type { AgentCatalog } from "../../packages/contracts/src/assistant-agent.js";
import { resolveAssistantModelPickerState } from "../../packages/contracts/src/assistant-model-picker.js";

const catalog: AgentCatalog = {
  defaultModel: "engine/default",
  notice: "仅显示已接通模型。",
  models: [
    {
      id: "engine/bailian",
      name: "快速问答",
      displayName: "DeepSeek V4.1 Flash · 百炼",
      vision: true,
      pdf: false,
      structured: false,
      parameters: ["tools"],
    },
  ],
  imageModels: [],
};

describe("assistant model picker fallback", () => {
  it("auto-selects the first available model instead of showing it as unavailable", () => {
    const state = resolveAssistantModelPickerState({
      catalog,
      value: undefined,
    });
    expect(state.selectedId).toBe("engine/bailian");
    expect(state.title).toBe("DeepSeek V4.1 Flash · 百炼");
    expect(state.autoSwitched).toBe(true);
    expect(state.hint).toContain("已自动切换到 DeepSeek V4.1 Flash · 百炼");
    expect(state.hint).toContain("未接通");
  });
  it("keeps an already available selection and uses a server fallback notice when needed", () => {
    const selected = resolveAssistantModelPickerState({
      catalog: {
        ...catalog,
        defaultModel: "engine/bailian",
        fallbackNotice:
          "已自动切换到 DeepSeek V4.1 Flash · 百炼（原默认模型未接通或最近一次调用未成功）",
      },
      value: "engine/bailian",
    });
    expect(selected.autoSwitched).toBe(false);
    expect(selected.title).toBe("DeepSeek V4.1 Flash · 百炼");
    expect(selected.hint).toContain("已自动切换到");
  });
  it("still reports an empty connected list as unavailable", () => {
    const empty = resolveAssistantModelPickerState({
      catalog: { ...catalog, models: [] },
      value: "engine/default",
    });
    expect(empty.title).toBe("所选模型不可用");
    expect(empty.autoSwitched).toBe(false);
    expect(empty.models).toEqual([]);
  });
});
