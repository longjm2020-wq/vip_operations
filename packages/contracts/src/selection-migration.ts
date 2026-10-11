import { z } from "zod";
import { selectionFieldSchema, selectionInitialColumnWidth } from "./selection-layout.js";
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
  { key: "registrationBatch", label: "登记批次", width: selectionInitialColumnWidth },
  { key: "images", label: "图片", width: selectionInitialColumnWidth },
  { key: "labelImages", label: "洗唛/吊牌图", width: selectionInitialColumnWidth },
  { key: "xutiStyleNo", label: "序缇款号", width: selectionInitialColumnWidth },
  { key: "supplierStyleNo", label: "供应商款号", width: selectionInitialColumnWidth },
  { key: "supplierCode", label: "供应商编码", width: selectionInitialColumnWidth },
  { key: "color", label: "颜色", width: selectionInitialColumnWidth },
  { key: "sizeRange", label: "尺码范围", width: selectionInitialColumnWidth },
  { key: "material", label: "材质成分", width: selectionInitialColumnWidth },
  { key: "supplyPriceExclTax", label: "供货价（不含税）", width: selectionInitialColumnWidth },
  { key: "vipPrice", label: "唯品价", width: selectionInitialColumnWidth },
  { key: "livePrice", label: "直播价", width: selectionInitialColumnWidth },
  { key: "tagPrice", label: "吊牌价", width: selectionInitialColumnWidth },
];
