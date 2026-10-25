export type DetailOutputType = "detail_page" | "main_image";
export const DEFAULT_DETAIL_RATIOS: Readonly<Record<DetailOutputType, string>>;
export function detailOutputRatio(project: { outputRatios?: Partial<Record<DetailOutputType, string>> }, type: DetailOutputType): string;
