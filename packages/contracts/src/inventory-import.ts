import { z } from "zod";
export const inventoryImportLimits = {
  maxFileSizeMB: 100,
  maxRows: 50000,
} as const;
export const inventoryImportFields = [
  {
    key: "skuCode",
    label: "商品编码",
    aliases: ["SKU", "SKU 编码", "SKU编码"],
    required: true,
  },
  { key: "colorName", label: "颜色", aliases: ["颜色名称"] },
  { key: "sizeName", label: "尺码", aliases: ["尺码名称"] },
  { key: "barcode", label: "条码", aliases: [] },
  { key: "articleNo", label: "货号", aliases: [] },
  { key: "dailySales", label: "渠道日销参考", aliases: [], number: true },
  {
    key: "returnRatePercent",
    label: "退货率",
    aliases: ["退货率（%）"],
    number: true,
  },
  { key: "estimatedReturns", label: "预估销退数", aliases: [], number: true },
  { key: "targetDays", label: "补货目标天数", aliases: [], number: true },
  { key: "sourceNote", label: "参考来源", aliases: ["参考来源 / 渠道"] },
  { key: "referenceDate", label: "参考日期", aliases: [] },
  { key: "warehouse", label: "仓库", aliases: ["仓库编码", "仓库名称"] },
  {
    key: "physicalQty",
    label: "在仓库存数",
    aliases: ["实际库存"],
    number: true,
  },
  { key: "quantity", label: "变化数量", aliases: [], number: true },
  { key: "reason", label: "原因", aliases: [] },
  { key: "remark", label: "说明", aliases: [] },
] as const;
const text = z.string().trim().min(1).max(100);
const count = z.number().int().min(0).max(10000000);
export const inventoryImportSchema = z
  .object({
    skuCode: text,
    warehouse: z.string().trim().min(1).max(100).optional(),
    warehouseId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    changes: z
      .object({
        colorName: text.optional(),
        sizeName: text.optional(),
        barcode: text.optional(),
        articleNo: z.string().trim().min(1).max(100).optional(),
        dailySales: z.number().min(0).max(1000000).optional(),
        returnRatePercent: z.number().min(0).max(100).optional(),
        estimatedReturns: count.optional(),
        targetDays: z.number().int().min(1).max(365).optional(),
        sourceNote: z.string().trim().min(1).max(500).optional(),
        referenceDate: z.iso.date().optional(),
        physicalQty: count.optional(),
        quantity: z
          .number()
          .int()
          .min(-10000000)
          .max(10000000)
          .refine((v) => v !== 0)
          .optional(),
        reason: z.enum(["OPENING", "STOCKTAKE", "MANUAL"]).optional(),
        remark: z.string().trim().min(1).max(1000).optional(),
      })
      .strict()
      .refine(
        (v) => Object.keys(v).some((k) => k !== "reason" && k !== "remark"),
        "没有可修改的列",
      )
      .refine(
        (v) => v.physicalQty === undefined || v.quantity === undefined,
        "在仓库存数与变化数量只能填写一项",
      ),
  })
  .strict();
export type InventoryImportInput = z.infer<typeof inventoryImportSchema>;
