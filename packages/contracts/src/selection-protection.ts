import { z } from "zod";

export const selectionFields = [
  "registrationBatch",
  "images",
  "labelImages",
  "xutiStyleNo",
  "supplierStyleNo",
  "supplierCode",
  "color",
  "sizeRange",
  "material",
  "supplyPriceExclTax",
  "vipPrice",
  "livePrice",
  "tagPrice",
  "sellingPoints",
  "reorderDays",
  "collectionInventory",
];
const userId = z.string().regex(/^[1-9]\d{0,18}$/);
const field = z
  .string()
  .max(100)
  .refine(
    (key) =>
      selectionFields.includes(key) || /^custom:[a-zA-Z0-9:-]+$/.test(key),
  );
export const selectionAccessSchema = z.enum(["edit", "read", "deny"]);
export type SelectionAccess = z.infer<typeof selectionAccessSchema>;
export const protectionRegionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    scope: z.enum(["cells", "rows", "columns", "sheet"]),
    rowIds: z.array(userId).max(5000),
    columnKeys: z.array(field).max(100),
    users: z
      .record(userId, selectionAccessSchema)
      .refine((value) => Object.keys(value).length <= 500),
    others: selectionAccessSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      ((value.scope === "cells" || value.scope === "rows") &&
        !value.rowIds.length) ||
      ((value.scope === "cells" || value.scope === "columns") &&
        !value.columnKeys.length)
    )
      ctx.addIssue({ code: "custom", message: "请选择保护区域" });
  });
export const selectionProtectionSchema = z
  .object({
    enabled: z.boolean(),
    claimsEnabled: z.boolean(),
    autoHide: z.boolean(),
    hiddenReaders: z.array(userId).max(500),
    regions: z.array(protectionRegionSchema).max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.regions.map((region) => region.id)).size ===
      value.regions.length,
    "保护区域标识重复",
  );
export type SelectionProtection = z.infer<typeof selectionProtectionSchema>;
export type ProtectionRegion = z.infer<typeof protectionRegionSchema>;
export const defaultProtection: SelectionProtection = {
  enabled: false,
  claimsEnabled: false,
  autoHide: false,
  hiddenReaders: [],
  regions: [],
};
export type ProtectionActor = {
  id: string;
  permissions: string[];
  roleCodes?: string[];
  selectionWorkspaceScoped?: boolean;
};
export const protectionAdmin = (actor: ProtectionActor) =>
  actor.permissions.includes("selection.protect") ||
  !!actor.roleCodes?.some((code) => code === "SUPER_ADMIN" || (!actor.selectionWorkspaceScoped && code === "ADMIN"));
export function regionMatches(
  region: ProtectionRegion,
  rowId: string,
  key: string,
) {
  return (
    region.scope === "sheet" ||
    (region.scope === "rows" && region.rowIds.includes(rowId)) ||
    (region.scope === "columns" && region.columnKeys.includes(key)) ||
    (region.scope === "cells" &&
      region.rowIds.includes(rowId) &&
      region.columnKeys.includes(key))
  );
}
export function selectionCellAccess(
  settings: SelectionProtection,
  actor: ProtectionActor,
  row: {
    id?: unknown;
    createdBy?: unknown;
    claimedBy?: unknown;
    cellOwners?: Record<string, unknown>;
  },
  key: string,
  hasContent = true,
): SelectionAccess {
  if (!actor.permissions.includes("selection.read")) return "deny";
  let level = actor.permissions.includes("selection.manage") ? 2 : 1;
  if (protectionAdmin(actor)) return level === 2 ? "edit" : "read";
  if (settings.enabled)
    for (const region of settings.regions)
      if (regionMatches(region, String(row.id || ""), key))
        level = Math.min(
          level,
          { edit: 2, read: 1, deny: 0 }[
            region.users[actor.id] || region.others
          ],
        );
  if (
    settings.autoHide &&
    hasContent &&
    String(row.createdBy) !== actor.id &&
    String(row.cellOwners?.[key]) !== actor.id &&
    !settings.hiddenReaders.includes(actor.id)
  )
    level = 0;
  if (
    settings.claimsEnabled &&
    row.claimedBy &&
    String(row.claimedBy) !== actor.id
  )
    level = Math.min(level, 1);
  return (["deny", "read", "edit"] as const)[level];
}
