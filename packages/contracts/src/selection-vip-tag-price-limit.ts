import { z } from "zod";
import type { SelectionField } from "./selection-layout.js";

/** Category names are exact labels. In particular, a slash is part of a label. */
export function normalizeVipTagPriceCategory(raw: unknown): string {
  return typeof raw === "string" ? raw.normalize("NFKC").trim() : "";
}

export const selectionVipTagPriceLimitRuleSchema = z.object({
  category: z.string().transform(normalizeVipTagPriceCategory).pipe(z.string().min(1).max(80)),
  limit: z.number().finite().min(0).max(999999999.99).multipleOf(0.01),
}).strict();

export const selectionVipTagPriceLimitConfigSchema = z.object({
  sourceKey: z.string().trim().min(1).max(100),
  rules: z.array(selectionVipTagPriceLimitRuleSchema).max(500),
}).strict().superRefine((config, context) => {
  const seen = new Set<string>();
  config.rules.forEach((rule, index) => {
    if (seen.has(rule.category)) context.addIssue({
      code: "custom", path: ["rules", index, "category"], message: "三级类目不能重复",
    });
    seen.add(rule.category);
  });
});

export type SelectionVipTagPriceLimitConfig = z.infer<typeof selectionVipTagPriceLimitConfigSchema>;
export type VipTagPriceLimitConfig = SelectionVipTagPriceLimitConfig;

/** Initial rules supplied by the user; each field stores its own editable copy. */
export const defaultVipTagPriceLimitRules: readonly SelectionVipTagPriceLimitConfig["rules"][number][] = [
  { category: "半截裙", limit: 899 },
  { category: "连衣裙", limit: 2799 },
  { category: "女士皮衣/皮草", limit: 19999 },
  { category: "女式T恤", limit: 1499 },
  { category: "女式背心", limit: 899 },
  { category: "女式衬衫", limit: 1999 },
  { category: "女式打底衫", limit: 599 },
  { category: "女式大衣", limit: 3999 },
  { category: "女式风衣", limit: 1799 },
  { category: "女式礼服", limit: 2999 },
  { category: "女式马夹", limit: 1299 },
  { category: "女式外套", limit: 1599 },
  { category: "女式卫衣", limit: 899 },
  { category: "女式休闲裤", limit: 1799 },
  { category: "女式羊毛衫", limit: 1599 },
  { category: "女式羊绒衫", limit: 3999 },
  { category: "女式羽绒服", limit: 12999 },
  { category: "女式针织衫", limit: 999 },
];

export function defaultVipTagPriceLimitConfig(sourceKey = ""): SelectionVipTagPriceLimitConfig {
  return { sourceKey, rules: defaultVipTagPriceLimitRules.map(rule => ({ ...rule })) };
}

/** This predicate identifies the derived price field, not system metadata fields. */
export function isSelectionComputedField(field: Pick<SelectionField, "type" | "fallbackType">): boolean {
  return (field.type || field.fallbackType) === "vipTagPriceLimit";
}

function sourceCategory(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  // A literal A/B single choice is encoded to distinguish it from old multiple
  // choice transport. Multiple selected categories have no unambiguous limit.
  const prefix = "@choices//v1:";
  if (!value.startsWith(prefix)) return normalizeVipTagPriceCategory(value);
  try {
    const parsed: unknown = JSON.parse(value.slice(prefix.length));
    if (!Array.isArray(parsed) || parsed.length !== 1) return "";
    return normalizeVipTagPriceCategory(parsed[0]);
  } catch { return ""; }
}

/** Returns null for missing, unmatched, ambiguous or malformed input. */
export function matchVipTagPriceLimit(
  config: SelectionVipTagPriceLimitConfig,
  rawCategory: unknown,
): number | null {
  const category = sourceCategory(rawCategory);
  if (!category || !config || !Array.isArray(config.rules)) return null;
  let result: number | null = null;
  for (const rule of config.rules) {
    if (!rule || normalizeVipTagPriceCategory(rule.category) !== category) continue;
    const limit = rule.limit;
    if (result !== null || !Number.isFinite(limit) || limit < 0 || limit > 999999999.99 ||
      limit !== Math.round(limit * 100) / 100) return null;
    result = limit;
  }
  return result;
}

/** Calculate from permission-projected rows only; never read saved target data. */
export function resolveVipTagPriceLimit(
  field: Pick<SelectionField, "key" | "type" | "fallbackType" | "vipTagPriceLimitConfig">,
  row: Record<string, unknown>,
  options?: { categoryNames?: Readonly<Record<string, string>> },
): number | null {
  if (!isSelectionComputedField(field) || !field.vipTagPriceLimitConfig) return null;
  const config = field.vipTagPriceLimitConfig, sourceKey = config.sourceKey;
  if (!sourceKey || sourceKey === field.key ||
    (Array.isArray(row.hiddenCells) && row.hiddenCells.includes(sourceKey))) return null;
  const access = row.cellAccess;
  const custom = sourceKey.startsWith("custom:");
  if (access && typeof access === "object" &&
    (((access as Record<string, unknown>)[sourceKey] ?? row.defaultCellAccess) === "deny" ||
      (custom && !Object.hasOwn(access, sourceKey)))) return null;
  const source = custom ? row.extraFields : row;
  if (!source || typeof source !== "object" || !Object.hasOwn(source, sourceKey)) return null;
  const raw = (source as Record<string, unknown>)[sourceKey];
  if (sourceKey === "custom:product:categoryId") {
    // Archive reference fields store an id. Only the caller's authorized
    // category labels can translate it into a category name.
    const id = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
    return matchVipTagPriceLimit(config, options?.categoryNames?.[id]);
  }
  return matchVipTagPriceLimit(config, raw);
}
