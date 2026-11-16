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
  const text = {
    ...catalog.models[0],
    id: "agentai/text",
    name: "AgentAI Text",
    displayName: "AgentAI Text",
    vision: false,
    chatVerifiedAt: "2026-11-16T12:00:00Z",
  };
  it("keeps verified AgentAI text models visible without opening legacy text or unverified AgentAI models", () => {
    const state = resolveAssistantModelPickerState({
      catalog: {
        ...catalog,
        models: [
          ...catalog.models,
          text,
          { ...text, id: "engine/text" },
          { ...text, id: "agentai/unverified", chatVerifiedAt: null },
        ],
      },
      value: text.id,
    });
    expect(state.models.map((m) => m.id)).toEqual([
      "engine/bailian",
      "agentai/text",
    ]);
    expect(state.selectedId).toBe(text.id);
    expect(state.autoSwitched).toBe(false);
    expect(state.title).toBe("AgentAI Text");
  });
  it("does not switch an explicitly selected AgentAI model to another provider after verification disappears", () => {
    const state = resolveAssistantModelPickerState({
      catalog: {
        ...catalog,
        models: [...catalog.models, { ...text, chatVerifiedAt: null }],
      },
      value: text.id,
    });
    expect(state.selected).toBeUndefined();
    expect(state.autoSwitched).toBe(false);
    expect(state.hint).toContain("未自动切换线路");
    expect(state.title).toBe("所选 AgentAI 型号不可用");
  });
  it("preserves the same no-switch boundary for an unavailable AgentAI default", () => {
    const state = resolveAssistantModelPickerState({
      catalog: { ...catalog, defaultModel: text.id },
    });
    expect(state.selectedId).toBeUndefined();
    expect(state.autoSwitched).toBe(false);
  });
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
