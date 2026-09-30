import type { SelectionField } from "./selection-field-types.js";
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
    if (!value || !Number.isFinite(Date.parse(value))) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(field.timeDisplay === "date"
        ? {}
        : {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          }),
    }).formatToParts(new Date(value));
    const get = (type: string) =>
      parts.find((part) => part.type === type)?.value || "";
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    return field.timeDisplay === "date"
      ? date
      : `${date} ${get("hour")}:${get("minute")}:${get("second")}`;
  }
  if (type === "autonumber") {
    if (!/^\d+$/.test(String(row.id || ""))) return "";
    const config = field.numberConfig;
    return `${config?.prefix || ""}${String(row.id).padStart(Math.min(20, Math.max(1, config?.digits || 1)), "0")}${config?.suffix || ""}`;
  }
  return "";
}
