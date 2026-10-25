export const DETAIL_ASSET_KINDS: readonly ["person", "brand", "product", "scene"];
export const DETAIL_SCENES: string[];
export function detailAssetName(filename: string): string;
export function parseDetailDocument(kind: string, text: string): Record<string, unknown>;
export function mergeDetailInformation<T>(current: T, incoming: Record<string, unknown>): T;
