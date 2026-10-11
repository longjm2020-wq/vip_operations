import type { SelectionField } from "./selection-field-types.js";
import { formatSelectionCreatedTime } from "../../../packages/contracts/src/selection-created-time.js";
export function selectionSystemValue(
  row: Record<string, any>,
  field: SelectionField,
): string {
  const type = field.type || field.fallbackType;
  if (type === "creator" || type === "modifier") {
    const prefix = type === "creator" ? "createdBy" : "updatedBy",
      name = row[prefix + "Name"],
      username = row[prefix + "Username"];
    if (!row[prefix]) return "";
    if (field.personDisplay === "username")
      return username || String(row[prefix]);
    if (field.personDisplay === "both")
      return name && username && name !== username
        ? `${name}（${username}）`
        : name || username || String(row[prefix]);
    return name || username || String(row[prefix]);
  }
  if (type === "createdTime" || type === "modifiedTime") {
    const value = row[type === "createdTime" ? "createdAt" : "updatedAt"];
    return formatSelectionCreatedTime(value, field.timeDisplay);
  }
  if (type === "autonumber") {
    if (!/^\d+$/.test(String(row.id || ""))) return "";
    const config = field.numberConfig;
    return `${config?.prefix || ""}${String(row.id).padStart(Math.min(20, Math.max(1, config?.digits || 1)), "0")}${config?.suffix || ""}`;
  }
  return "";
}
