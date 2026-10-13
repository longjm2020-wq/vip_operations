import type {
  ProtectionRegion,
  SelectionProtection,
} from "../../../packages/contracts/src/selection-protection.js";

export type ProtectionUserCapability = {
  id: string;
  canEdit?: boolean;
  canManage?: boolean;
  editBlockReason?: string | null;
};

export type ProtectionEditWarning = {
  userId: string;
  moduleReason?: string;
  overlappingRegions: string[];
};

/** Scope intersection is independent of row ordering and current pagination. */
export function protectionRegionsOverlap(
  first: ProtectionRegion,
  second: ProtectionRegion,
): boolean {
  const allRows = (region: ProtectionRegion) =>
    region.scope === "sheet" || region.scope === "columns";
  const allColumns = (region: ProtectionRegion) =>
    region.scope === "sheet" || region.scope === "rows";
  const intersects = (firstKeys: string[], secondKeys: string[]) => {
    const keys = new Set(secondKeys);
    return firstKeys.some((key) => keys.has(key));
  };
  return (
    (allRows(first) || allRows(second) || intersects(first.rowIds, second.rowIds)) &&
    (allColumns(first) || allColumns(second) || intersects(first.columnKeys, second.columnKeys))
  );
}

/** Explain configured edit grants that still meet independent restrictions. */
export function protectionEditWarnings(
  region: ProtectionRegion,
  settings: SelectionProtection,
  users: ProtectionUserCapability[],
): ProtectionEditWarning[] {
  const capabilities = new Map(users.map((person) => [String(person.id), person]));
  const overlaps = settings.regions.filter(
    (other) => other.id !== region.id && protectionRegionsOverlap(region, other),
  );
  return Object.entries(region.users).flatMap(([userId, access]) => {
    if (access !== "edit") return [];
    const capability = capabilities.get(userId);
    const moduleReason = capability?.canEdit === false
      ? capability.editBlockReason || "没有本表内容编辑权限"
      : undefined;
    const overlappingRegions = capability?.canManage === true ? [] : overlaps
      .filter((other) => {
        const specified = Object.hasOwn(other.users, userId);
        // A local named edit grant overrides only the whole sheet's default read.
        if (region.scope !== "sheet" && other.scope === "sheet" &&
          !specified && other.others === "read") return false;
        return (specified ? other.users[userId] : other.others) !== "edit";
      })
      .map((other) => other.name);
    return moduleReason || overlappingRegions.length
      ? [{ userId, moduleReason, overlappingRegions }]
      : [];
  });
}
