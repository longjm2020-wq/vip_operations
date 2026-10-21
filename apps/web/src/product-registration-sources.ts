import type { SelectionField } from "../../../packages/contracts/src/selection-layout.js";
import { selectionImageColorValues } from "../../../packages/contracts/src/selection-image-colors.js";
import { choiceDisplayText } from "./selection-choice-display.js";

export const registrationLimits = { styles: 500, skus: 50000 };
export type RegistrationMapping = { code: string; name: string; status: string };
export type RegistrationMappings = { colors: RegistrationMapping[]; sizes: RegistrationMapping[] };
export type RegistrationIssue = { rowId: string; style: string; severity: "error" | "warning"; message: string };
export type RegistrationResult = { rows: (string | number)[][]; issues: RegistrationIssue[]; styleCount: number };
export const registrationDefinitions = {
  style: { labels: ["序缇款号"], keys: ["xutiStyleNo"] },
  colors: { labels: ["标准颜色"], keys: [] },
  sizes: { labels: ["尺码范围"], keys: ["sizeRange"] },
  supplierColors: { labels: ["供应商颜色"], keys: ["color"] },
  category: { labels: ["三级类目", "三级品类", "三级分类"], keys: ["custom:product:categoryId"] },
  longTitle: { labels: ["长标题"], keys: [] },
  shortTitle: { labels: ["短标题"], keys: [] },
  supplierStyle: { labels: ["供应商款号"], keys: ["supplierStyleNo"] },
  supplierName: { labels: ["供应商名称"], keys: ["custom:product:defaultSupplierId", "supplierCode"] },
  tagPrice: { labels: ["吊牌价"], keys: ["tagPrice"] },
  vipPrice: { labels: ["唯品价"], keys: ["vipPrice"] },
  cost: { labels: ["供货价（不含税）", "供货价(不含税)"], keys: ["supplyPriceExclTax"] },
  material: { labels: ["成分", "材质成分", "材质"], keys: ["material"] },
  safety: { labels: ["安全类别"], keys: [] },
  standard: { labels: ["执行标准"], keys: [] },
} satisfies Record<string, { labels: string[]; keys: string[] }>;
export type RegistrationKey = keyof typeof registrationDefinitions;
export type RegistrationSource<K extends RegistrationKey = RegistrationKey> = {
  id: string; values: Record<K, string>; colors: string[]; sizes: string[]; supplierColors: string[]; issues: RegistrationIssue[];
};
const requiredKeys = new Set<RegistrationKey>(["style", "colors", "sizes", "category"]);
export const normalizeRegistrationValue = (text: string) => text.normalize("NFKC").trim().toUpperCase();

/** Read only the template's registered fields, after the API's current permission projection. */
export function readRegistrationSources<K extends RegistrationKey>(
  rows: Record<string, any>[], fields: SelectionField[], keys: readonly K[],
  references: Record<string, { id: string; name: string }[]> = {},
): RegistrationSource<K>[] {
  const registered = fields.filter(field => !field.deleted);
  return rows.map(row => {
    const values = {} as Record<K, string>;
    const lists: Partial<Record<RegistrationKey, string[]>> = {};
    const issues: RegistrationIssue[] = [];
    for (const key of keys) {
      const definition: { labels: string[]; keys: string[] } = registrationDefinitions[key];
      const named = registered.filter(field => definition.labels.includes(field.label.trim()));
      const candidates = named.length ? named : definition.keys.flatMap(alias => registered.filter(field => field.key === alias)).slice(0, 1);
      const field = candidates.length === 1 ? candidates[0] : undefined;
      let reason = !candidates.length ? "未找到字段" : candidates.length > 1 ? "存在同名字段，请调整字段名称" : "";
      if (field && (row.hiddenCells?.includes(field.key) ||
        (row.cellAccess && (row.cellAccess[field.key] || row.defaultCellAccess) === "deny") ||
        (row.cellAccess && field.custom && !Object.hasOwn(row.cellAccess, field.key)))) reason = "无查看权限";
      if (reason || !field) {
        values[key] = "";
        issues.push({ rowId: String(row.id), style: "", severity: requiredKeys.has(key) ? "error" : "warning", message: `${definition.labels[0]}：${reason}，未读取该字段` });
        continue;
      }
      const raw = field.custom ? row.extraFields?.[field.key] : row[field.key];
      const referenceKey = field.key.startsWith("custom:product:") ? field.key.slice("custom:product:".length) : "";
      const reference = references[referenceKey];
      values[key] = reference ? reference.find(item => String(item.id) === String(raw))?.name || "" : choiceDisplayText(field, raw).trim();
      if (["colors", "sizes", "supplierColors"].includes(key)) lists[key] = selectionImageColorValues(field, raw);
      if (!values[key]) issues.push({ rowId: String(row.id), style: "", severity: requiredKeys.has(key) ? "error" : "warning",
        message: `${definition.labels[0]}为空${requiredKeys.has(key) ? "，请先补齐" : "，导出留空"}` });
    }
    const style = (values as Partial<Record<RegistrationKey, string>>).style || `所选记录 ${row.id}`;
    return { id: String(row.id), values, colors: lists.colors || [], sizes: lists.sizes || [], supplierColors: lists.supplierColors || [],
      issues: issues.map(issue => ({ ...issue, style })) };
  });
}

export function normalizedRegistrationSize(size: string): string {
  const value = normalizeRegistrationValue(size).replace(/\s/g, "");
  if (["F", "均码", "均码/F", "F/均码", "FREE", "ONESIZE"].includes(value)) return "F";
  if (/^X{2,8}L$/.test(value)) return `${value.length - 1}XL`;
  if (/^X{2,5}S$/.test(value)) return `${value.length - 1}XS`;
  return value;
}

export function defaultRegistrationSupplierColor(source: Pick<RegistrationSource, "colors" | "supplierColors">, color: string): string {
  return source.colors.length === source.supplierColors.length ? source.supplierColors[source.colors.indexOf(color)] || "" : "";
}

export function registrationMappingFor(value: string, entries: RegistrationMapping[], size: boolean): RegistrationMapping | undefined {
  const key = size ? normalizedRegistrationSize : normalizeRegistrationValue;
  const matches = entries.filter(entry => entry.status === "ACTIVE" && /^\d{3}$/.test(entry.code) &&
    (size || entry.code !== "044") && (key(entry.name) === key(value) || entry.code === value.trim()));
  return matches.length === 1 ? matches[0] : undefined;
}
