import { expect, it } from "vitest";
import { assistantPurposeMenu } from "../../apps/web/src/assistant-purpose-options.js";
import type {
  AgentCatalog,
  AgentModel,
} from "../../packages/contracts/src/assistant-agent.js";

const model = (
  id: string,
  name: string,
  extra: Partial<AgentModel> = {},
): AgentModel => ({
  id: `engine/${id}`,
  name,
  vision: false,
  pdf: false,
  structured: false,
  parameters: ["tools"],
  ...extra,
});
const catalog = (models: AgentModel[]): AgentCatalog => ({
  models,
  defaultModel: "engine/default",
  imageModels: [{ id: "engine/image", name: "图像创作", reference: true }],
  notice: "",
});

it("maps the available purposes to actual catalog entries", () => {
  const source = catalog([
    model("default", "通用助手", { vision: true }),
    model("flash", "快速问答", { vision: true }),
    model("deep-backup", "深度思考 · 备选"),
    model("deep", "深度思考"),
    model("visual", "视觉理解", { vision: true }),
    model("writer", "长文协作"),
  ]);
  const menu = assistantPurposeMenu(source);
  expect(menu.value).toBe("daily");
  expect(menu.options.map(({ label, model: id }) => [label, id])).toEqual([
    ["日常问答", "engine/default"],
    ["快速问答", "engine/flash"],
    ["深度分析", "engine/deep"],
    ["看图理解", "engine/visual"],
    ["写作", "engine/writer"],
  ]);
  expect(assistantPurposeMenu(source, "engine/flash").value).toBe("quick");
  expect(source.imageModels).toEqual([
    { id: "engine/image", name: "图像创作", reference: true },
  ]);
});

it("only offers supported purposes and preserves an explicit purpose sharing a model", () => {
  const textOnly = catalog([model("default", "通用助手")]);
  expect(assistantPurposeMenu(textOnly).options.map((o) => o.label)).toEqual([
    "日常问答",
    "写作",
  ]);
  const capable = catalog([
    model("default", "通用助手", {
      vision: true,
      parameters: ["tools", "reasoning"],
    }),
  ]);
  const menu = assistantPurposeMenu(capable, "engine/default", "vision");
  expect(menu.value).toBe("vision");
  expect(menu.options).toHaveLength(4);
  expect(menu.options.every((o) => o.model === "engine/default")).toBe(true);
});

it("retains alternate or unavailable selections without revealing their names or replacing IDs", () => {
  const source = catalog([
    model("default", "通用助手"),
    model("deep", "深度思考"),
    model("backup", "DeepSeek provider/model"),
  ]);
  for (const current of ["engine/backup", "engine/removed"]) {
    const menu = assistantPurposeMenu(source, current, "analysis");
    expect(menu.value).toBe("current");
    expect(menu.options.at(-1)).toEqual({
      value: "current",
      label: "当前选择",
      model: current,
    });
    expect(menu.options.map((o) => o.label).join()).not.toMatch(
      /DeepSeek|provider|备选|识图/,
    );
  }
  expect(assistantPurposeMenu(undefined, "engine/removed")).toEqual({
    value: "current",
    options: [{ value: "current", label: "当前选择", model: "engine/removed" }],
  });
});

it("does not let a refreshed purpose mapping silently select a new model", () => {
  const source = catalog([
    model("default", "通用助手"),
    model("new-deep", "深度思考"),
    model("old-deep", "深度思考 · 备选"),
    model("not-visual", "视觉理解"),
  ]);
  const menu = assistantPurposeMenu(source, "engine/old-deep", "analysis");
  expect(menu.value).toBe("current");
  expect(menu.options.find((o) => o.value === menu.value)?.model).toBe(
    "engine/old-deep",
  );
  expect(menu.options.some((o) => o.value === "vision")).toBe(false);
  expect(assistantPurposeMenu(undefined).options).toEqual([]);
});
