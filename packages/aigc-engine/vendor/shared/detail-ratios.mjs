export const DEFAULT_DETAIL_RATIOS = Object.freeze({ detail_page: "9:16", main_image: "1:1" });

export function detailOutputRatio(project, type) {
  return project.outputRatios?.[type] ?? DEFAULT_DETAIL_RATIOS[type];
}
