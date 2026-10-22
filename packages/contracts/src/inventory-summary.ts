import { z } from "zod";

export const inventoryPageSizes = [20, 50, 100, 200, 500, 1000, 5000];
export const inventoryPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(5000).default(20),
});

export const inventoryDimensionSchema = z.enum(["sku", "article", "style"]);
export type InventoryDimension = z.infer<typeof inventoryDimensionSchema>;
export const inventoryReportMatchSchema = z.enum([
  "all",
  "matched",
  "unmatched",
]);
export type InventoryReportMatch = z.infer<typeof inventoryReportMatchSchema>;
export const inventoryBarcodeStateSchema = z.enum(["LISTED", "UNLISTED", "UNPUBLISHED"]);
export const inventoryStyleStateSchema = z.enum(["LISTED", "UNLISTED", "PARTIAL", "UNPUBLISHED"]);
export type InventoryBarcodeState = z.infer<typeof inventoryBarcodeStateSchema>;
export type InventoryStyleState = z.infer<typeof inventoryStyleStateSchema>;
export type InventoryListingCounts = {
  barcode: Record<InventoryBarcodeState, number> & { total: number; other: number };
  style: Record<InventoryStyleState, number> & { total: number; other: number };
};
export const inventoryReferencePeriodSchema = z.enum([
  "3d", "7d", "15d", "30d", "3m", "6m", "1y",
]);
export type InventoryReferencePeriod = z.infer<typeof inventoryReferencePeriodSchema>;
export const inventoryReferencePeriods = [
  { value: "3d", label: "近3天" },
  { value: "7d", label: "近7天" },
  { value: "15d", label: "近15天" },
  { value: "30d", label: "近30天" },
  { value: "3m", label: "近3个月" },
  { value: "6m", label: "近半年" },
  { value: "1y", label: "近1年" },
] as const satisfies readonly { value: InventoryReferencePeriod; label: string }[];
export const inventoryDimensions = [
  { key: "sku", label: "条码（商品编码）" },
  { key: "article", label: "货号" },
  { key: "style", label: "款号" },
] as const;

// Only physical stock and separately tracked quantities are additive.
export const inventoryStockFields = [
  "physicalQty",
  "inTransitQty",
  "transferTransitQty",
  "incomingQty",
  "availableQty",
  "reservedQty",
  "damagedQty",
] as const;
