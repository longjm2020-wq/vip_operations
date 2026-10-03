import { z } from "zod";

export const inventoryDimensionSchema = z.enum(["sku", "article", "style"]);
export type InventoryDimension = z.infer<typeof inventoryDimensionSchema>;
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
