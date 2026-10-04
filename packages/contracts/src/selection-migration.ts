import { z } from "zod";
import { selectionFieldSchema } from "./selection-layout.js";
import { migrationConfigSchema } from "./selection-migration-config.js";
export {
  workspaceKey,
  migrationMappingSchema,
  migrationConfigSchema,
} from "./selection-migration-config.js";
export const migrationPreviewSchema = migrationConfigSchema
  .extend({
    rowIds: z
      .array(z.string().regex(/^[1-9]\d{0,18}$/))
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    fields: z.array(selectionFieldSchema).max(500),
  })
  .strict();
export const migrationCommitSchema = migrationPreviewSchema
  .extend({ token: z.string().length(64) })
  .strict();

export const selectionBaseFields = [
  { key: "registrationBatch", label: "登记批次", width: 120 },
  { key: "images", label: "图片", width: 120 },
  { key: "labelImages", label: "洗唛/吊牌图", width: 120 },
  { key: "xutiStyleNo", label: "序缇款号", width: 120 },
  { key: "supplierStyleNo", label: "供应商款号", width: 120 },
  { key: "supplierCode", label: "供应商编码", width: 120 },
  { key: "color", label: "颜色", width: 120 },
  { key: "sizeRange", label: "尺码范围", width: 120 },
  { key: "material", label: "材质成分", width: 120 },
  { key: "supplyPriceExclTax", label: "供货价（不含税）", width: 120 },
  { key: "vipPrice", label: "唯品价", width: 120 },
  { key: "livePrice", label: "直播价", width: 120 },
  { key: "tagPrice", label: "吊牌价", width: 120 },
];
