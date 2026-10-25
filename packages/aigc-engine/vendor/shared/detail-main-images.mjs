export const MAX_DETAIL_MODULES = 80;
export const isMainImageModule = module => module.id.startsWith("MAIN-") || module.type === "main";

export function requestedMainImageCount(project) {
  const count = project.mainImageCount ?? project.modules?.filter(isMainImageModule).length;
  return Number.isInteger(count) && count > 0 ? Math.min(count, MAX_DETAIL_MODULES) : 6;
}

const presets = [["中景正面", "front"], ["中景侧面", "side"], ["中景背面", "back"], ["中景坐姿 / 倚靠", "custom"], ["中景氛围图", "custom"], ["多角度产品细节", "custom"]];
function newMainImage(index) {
  const [name, angle] = presets[index - 1] || [`主图 ${index}`, "custom"];
  return {
    id: `MAIN-${String(index).padStart(3, "0")}`, name, type: "main", enabled: true, required: false,
    content: { headline: "", subheadline: "", body: "", data_blocks: [] },
    layout: { template: "editorial", text_position: "auto", image_position: "center", whitespace_level: "medium", grid: null },
    shot: { shot_size: index === 6 ? "closeup" : "medium", angle, pose: "", camera_notes: "" },
    asset_bindings: { brand_asset_ids: [], person_asset_ids: [], product_asset_ids: [], scene_asset_ids: [] },
    locks: { product_truth: true, person_truth: true, brand_rules: true },
    prompt_overrides: { positive: "", negative: "" }, trigger_tags: [],
  };
}

export function resizeMainImages(modules, count) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_DETAIL_MODULES) throw new Error("主图数量须为 1–80 的整数");
  const current = modules.filter(isMainImageModule);
  if (current.length === count) return modules;
  const retained = new Set(current.slice(0, count).map(module => module.id));
  const next = modules.filter(module => !isMainImageModule(module) || retained.has(module.id));
  const used = new Set(modules.map(module => module.id));
  let number = 1;
  for (let index = current.length; index < count; index++) {
    while (used.has(`MAIN-${String(number).padStart(3, "0")}`)) number++;
    const added = newMainImage(number++);
    used.add(added.id);
    const lastMain = next.findLastIndex(isMainImageModule);
    next.splice(lastMain < 0 ? next.length : lastMain + 1, 0, added);
  }
  return next;
}
