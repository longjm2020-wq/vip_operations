import type { SelectionField } from "./selection-field-types.js";
import { formatSelectionCreatedTime } from "../../../packages/contracts/src/selection-created-time.js";
import { selectionCreationTimeValue } from "./selection-creation-time.js";
import { resolveVipTagPriceLimit } from "../../../packages/contracts/src/selection-vip-tag-price-limit.js";

type References = Record<string, Record<string, any>[]>;
const categoryNameCache = new WeakMap<object, Record<string, string>>();
function categoryNames(references?: References) {
  const categories = references?.categoryId;
  if (!categories) return undefined;
  let names = categoryNameCache.get(categories);
  if (!names) {
    names = Object.fromEntries(categories.map(category => [String(category.id), String(category.name)]));
    categoryNameCache.set(categories, names);
  }
  return names;
}
export function selectionSystemValue(
  row: Record<string, any>,
  field: SelectionField,
  references?: References,
): string {
  const type = field.type || field.fallbackType;
  if (type === "vipTagPriceLimit") {
    const value = resolveVipTagPriceLimit(field, row, { categoryNames: categoryNames(references) });
    return value === null ? "" : String(value);
  }
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
    if (type === "createdTime" && field.key === "registrationBatch" && !field.custom) return selectionCreationTimeValue(row, field.timeDisplay);
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
