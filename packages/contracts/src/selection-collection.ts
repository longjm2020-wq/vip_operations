import { z } from "zod";
import { sortSelectionSizes } from "./selection-sizes.js";

export const collectionTags = (value: string) => [...new Set(value.split("/").map(item => item.trim()).filter(Boolean))];
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "请输入有效日期");
const quantity = z.number().int().min(0).max(10000000);
export const collectionStockSchema = z.object({
  color: z.string().trim().min(1).max(100),
  size: z.string().trim().min(1).max(100),
  available: quantity,
  production: quantity,
  sellOutDate: date.nullable(),
  shipDate: date.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.available > 0 && !value.sellOutDate) ctx.addIssue({code:"custom",path:["sellOutDate"],message:"现货库存大于零时请填写预计售罄日期"});
  if (value.production > 0 && !value.shipDate) ctx.addIssue({code:"custom",path:["shipDate"],message:"支持做货库存大于零时请填写预计出货日期"});
});
export type CollectionStock = z.infer<typeof collectionStockSchema>;
const collectionBaseSchema = z.object({
  supplierStyleNo: z.string().trim().max(64),
  color: z.string().trim().max(100),
  sizeRange: z.string().trim().max(100).transform(sortSelectionSizes),
  material: z.string().trim().max(2000),
  supplyPriceExclTax: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).nullable(),
  sellingPoints: z.string().max(1000),
  reorderDays: z.number().int().min(0).max(36500).nullable(),
  inventory: z.array(collectionStockSchema).max(400),
}).strict();
export const collectionInfoSchema = collectionBaseSchema.superRefine((value, ctx) => {
  for (const [field, label] of [["supplierStyleNo", "供应商款号"], ["color", "颜色"], ["sizeRange", "尺码范围"], ["material", "材质成分"], ["sellingPoints", "产品卖点/简介"]] as const) {
    if (!value[field].trim()) ctx.addIssue({code:"custom",path:[field],message:`请填写${label}`});
  }
  if (value.supplyPriceExclTax === null) ctx.addIssue({code:"custom",path:["supplyPriceExclTax"],message:"请填写供货价（不含税）"});
  if (value.reorderDays === null) ctx.addIssue({code:"custom",path:["reorderDays"],message:"请填写翻单周期（天）"});
  const combinations = new Set(collectionTags(value.color).flatMap(color => collectionTags(value.sizeRange).map(size => JSON.stringify([color, size]))));
  const seen = new Set<string>();
  for (const stock of value.inventory) {
    const key = JSON.stringify([stock.color, stock.size]);
    if (!combinations.has(key) || seen.has(key)) ctx.addIssue({code:"custom",path:["inventory"],message:"库存明细与颜色尺码不一致或存在重复"});
    seen.add(key);
  }
  if (combinations.size !== seen.size) ctx.addIssue({code:"custom",path:["inventory"],message:"请填写每个颜色尺码组合的库存，无库存请填0"});
});
export type CollectionInfo = z.infer<typeof collectionInfoSchema>;
export const collectionSubmissionSchema = z.object({
  images: z.array(z.unknown()).min(1, "请至少上传一张图片"),
  info: collectionInfoSchema,
});
export function collectionInventory(colors: string, sizes: string, previous: CollectionStock[]): CollectionStock[] {
  return collectionTags(colors).flatMap(color => collectionTags(sortSelectionSizes(sizes)).map(size =>
    previous.find(item => item.color === color && item.size === size) || { color, size, available: 0, production: 0, sellOutDate: null, shipDate: null }));
}
export const collectionStockTotal = (inventory: CollectionStock[]) => inventory.reduce((total, item) => total + item.available + item.production, 0);

// Drafts retain partially entered dates; complete stock dates are required at submission.
export const collectionDraftSchema = collectionBaseSchema.extend({ inventory: z.array(z.object({ color:z.string().trim().min(1).max(100),size:z.string().trim().min(1).max(100),available:quantity,production:quantity,sellOutDate:z.string().max(10).nullable(),shipDate:z.string().max(10).nullable() }).strict()).max(400) });
