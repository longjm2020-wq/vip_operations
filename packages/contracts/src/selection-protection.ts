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
const regionScopeShape = {
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  scope: z.enum(["cells", "rows", "columns", "sheet"]),
  rowIds: z.array(userId).max(5000),
  columnKeys: z.array(field).max(100),
};
type RegionScope = {
  scope: "cells" | "rows" | "columns" | "sheet";
  rowIds: string[];
  columnKeys: string[];
};
const validScope = (value: RegionScope) =>
  !(((value.scope === "cells" || value.scope === "rows") && !value.rowIds.length) ||
    ((value.scope === "cells" || value.scope === "columns") && !value.columnKeys.length));
export const protectionRegionSchema = z
  .object({
    ...regionScopeShape,
    users: z
      .record(userId, selectionAccessSchema)
      .refine((value) => Object.keys(value).length <= 500),
    others: selectionAccessSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!validScope(value))
      ctx.addIssue({ code: "custom", message: "请选择保护区域" });
  });
export const autoHideRegionSchema = z.object(regionScopeShape).strict()
  .refine(validScope, "请选择内容自动隐藏区域");
export type AutoHideRegion = z.infer<typeof autoHideRegionSchema>;
export const selectionProtectionDraftSchema = z
  .object({
    enabled: z.boolean(),
    claimsEnabled: z.boolean(),
    autoHide: z.boolean(),
    autoHideRegions: z.array(autoHideRegionSchema).max(100).default([]),
    hiddenReaders: z.array(userId).max(500),
    regions: z.array(protectionRegionSchema).max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.regions.map((region) => region.id)).size ===
      value.regions.length,
    "保护区域标识重复",
  )
  .refine(
    (value) => new Set(value.autoHideRegions.map((region) => region.id)).size === value.autoHideRegions.length,
    "内容自动隐藏区域标识重复",
  );
export const selectionProtectionSchema = selectionProtectionDraftSchema
  .refine((value) => !value.autoHide || !!value.autoHideRegions.length,
    "请先添加内容自动隐藏区域");
export type SelectionProtection = z.infer<typeof selectionProtectionSchema>;
export type ProtectionRegion = z.infer<typeof protectionRegionSchema>;
export const defaultProtection: SelectionProtection = {
  enabled: false,
  claimsEnabled: false,
  autoHide: false,
  autoHideRegions: [],
  hiddenReaders: [],
  regions: [],
};
// Legacy stored policies hid every filled cell. Preserve that restriction as an
// explicit area until a manager changes it; new saves require an area choice.
export const legacyAutoHideRegion: AutoHideRegion = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "原整表自动隐藏",
  scope: "sheet",
  rowIds: [],
  columnKeys: [],
};
export function normalizeSelectionProtection(settings: SelectionProtection | Record<string, unknown> | null | undefined): SelectionProtection {
  const value = settings || defaultProtection;
  return {
    ...defaultProtection,
    ...value,
    autoHideRegions: Object.hasOwn(value, "autoHideRegions")
      ? (value.autoHideRegions as AutoHideRegion[])
      : value.autoHide ? [{ ...legacyAutoHideRegion, rowIds: [], columnKeys: [] }] : [],
  } as SelectionProtection;
}
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
  region: RegionScope,
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
    settings.autoHideRegions.some((region) => regionMatches(region, String(row.id || ""), key)) &&
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
