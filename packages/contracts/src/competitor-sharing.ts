import { z } from "zod";
import { competitorPriceBands } from "./competitor-analysis.js";

export const competitorShareFiltersSchema = z
  .object({
    category: z.string().trim().min(1).max(100).optional(),
    material: z.string().trim().min(1).max(40).optional(),
    season: z.string().trim().min(1).max(20).optional(),
    priceBand: z
      .enum(["under200", "200to500", "500to1000", "1000to2000", "over2000"])
      .optional(),
    keyword: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(["rank", "priceAsc", "priceDesc"]).optional(),
  })
  .strict();

export const competitorShareSchema = z
  .object({
    brandIds: z
      .array(z.string().regex(/^[1-9]\d{0,17}$/))
      .min(1)
      .max(12)
      .refine((ids) => new Set(ids).size === ids.length, "品牌不能重复"),
    filters: competitorShareFiltersSchema.default({}),
    days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
  })
  .strict();

export type CompetitorShareFilters = z.infer<
  typeof competitorShareFiltersSchema
>;
export function competitorShareScopeLabel(filters: CompetitorShareFilters) {
  return [
    filters.category && `品类：${filters.category}`,
    filters.material && `材质：${filters.material}`,
    filters.season && `季节：${filters.season}`,
    filters.priceBand &&
      `价格：${competitorPriceBands.find((b) => b.key === filters.priceBand)?.label}`,
    filters.keyword && `关键词：${filters.keyword}`,
    `排序：${filters.sort === "priceAsc" ? "特卖价从低到高" : filters.sort === "priceDesc" ? "特卖价从高到低" : "公开销量排名"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
