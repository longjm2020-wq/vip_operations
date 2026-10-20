import { Decimal } from "decimal.js";
import type { SelectionField } from "../../../packages/contracts/src/selection-layout.js";
import { selectionImageColorValues } from "../../../packages/contracts/src/selection-image-colors.js";
import { choiceDisplayText } from "./selection-choice-display.js";

// Positional columns are intentional: the supplied template repeats 供应商名称.
export const jushuitanHeaders = [
  "款式编码", "商品编码", "商品名称", "商品简称", "颜色及规格", "三级类目", "图片", "品牌",
  "供应商款式编码", "国标码", "供应商名称", "分类", "虚拟分类", "商品标签", "备注", "商品状态",
  "库存同步", "商品属性", "重量", "长", "宽", "高", "体积", "单位", "供应商名称", "市场|吊牌价",
  "基本售价", "成本价", "其它价格1", "其它价格2", "其它价格3", "其它价格4", "其它价格5",
  "其它属性1", "其它属性2", "成分", "安全类别", "执行标准",
] as const;
export const jushuitanLimits = { styles: 500, skus: 50000 };
export type JushuitanKind = "upper" | "lower";
export type JushuitanMapping = { code: string; name: string; status: string };
export type JushuitanMappings = { colors: JushuitanMapping[]; sizes: JushuitanMapping[] };
export type JushuitanIssue = { rowId: string; style: string; severity: "error" | "warning"; message: string };
type RawRow = Record<string, any>;
const definitions = {
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
type SourceKey = keyof typeof definitions;
export type JushuitanSource = {
  id: string;
  values: Record<SourceKey, string>;
  colors: string[];
  sizes: string[];
  supplierColors: string[];
  issues: JushuitanIssue[];
};
export type JushuitanOverride = { kind?: JushuitanKind; supplierColors?: Record<string, string> };
export type JushuitanOverrides = Record<string, JushuitanOverride>;
export type JushuitanResult = { rows: (string | number)[][]; issues: JushuitanIssue[]; styleCount: number };
const normalize = (text: string) => text.normalize("NFKC").trim().toUpperCase();
const requiredKeys = new Set<SourceKey>(["style", "colors", "sizes", "category"]);

/** Only registered, currently readable fields may contribute to a generated file. */
export function readJushuitanSources(
  rows: RawRow[], fields: SelectionField[], references: Record<string, { id: string; name: string }[]> = {},
): JushuitanSource[] {
  return rows.map(row => {
    const values = {} as Record<SourceKey, string>;
    const lists: Partial<Record<SourceKey, string[]>> = {};
    const issues: JushuitanIssue[] = [];
    for (const [key, definition] of Object.entries(definitions) as [SourceKey, { labels: string[]; keys: string[] }][]) {
      const registered = fields.filter(field => !field.deleted);
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
      values[key] = reference
        ? reference.find(item => String(item.id) === String(raw))?.name || ""
        : choiceDisplayText(field, raw).trim();
      if (["colors", "sizes", "supplierColors"].includes(key)) lists[key] = selectionImageColorValues(field, raw);
      if (!values[key]) issues.push({
        rowId: String(row.id), style: "", severity: requiredKeys.has(key) ? "error" : "warning",
        message: `${definition.labels[0]}为空${requiredKeys.has(key) ? "，请先补齐" : "，导出留空"}`,
      });
    }
    return { id: String(row.id), values, colors: lists.colors || [], sizes: lists.sizes || [], supplierColors: lists.supplierColors || [],
      issues: issues.map(issue => ({ ...issue, style: values.style || `所选记录 ${row.id}` })) };
  });
}

export function jushuitanGarmentKind(category: string): JushuitanKind | undefined {
  if (/连衣裙|礼服/.test(category)) return "upper";
  if (/裤|半截裙|半身裙|下装/.test(category)) return "lower";
  if (/上衣|上装|衬衫|T恤|T恤衫|背心|马[夹甲]|大衣|风衣|外套|卫衣|毛衫|绒衫|针织衫|毛衣|打底衫|羽绒服|棉衣|夹克|皮衣|皮草|西服/i.test(category)) return "upper";
  return undefined;
}

export function normalizedJushuitanSize(size: string): string {
  const value = normalize(size).replace(/\s/g, "");
  if (["F", "均码", "均码/F", "F/均码", "FREE", "ONESIZE"].includes(value)) return "F";
  if (/^X{2,8}L$/.test(value)) return `${value.length - 1}XL`;
  if (/^X{2,5}S$/.test(value)) return `${value.length - 1}XS`;
  return value;
}

export function jushuitanSizeLabel(size: string, kind: JushuitanKind): string | undefined {
  const value = normalizedJushuitanSize(size);
  let step = ({ S: -1, M: 0, L: 1, XL: 2, XS: -2, F: 0 } as Record<string, number>)[value];
  if (step === undefined && /^[2-8]XL$/.test(value)) step = Number(value[0]) + 1;
  if (step === undefined && /^[2-5]XS$/.test(value)) step = -Number(value[0]) - 1;
  return step === undefined ? undefined : `${160 + step * 5}/${(kind === "lower" ? 68 : 84) + step * 4}A(${value})`;
}

export function defaultJushuitanSupplierColor(source: JushuitanSource, color: string): string {
  // The supplied example pairs the two lists in order. Unequal lists need confirmation.
  return source.colors.length === source.supplierColors.length
    ? source.supplierColors[source.colors.indexOf(color)] || "" : "";
}

function mappingFor(value: string, entries: JushuitanMapping[], size: boolean): JushuitanMapping | undefined {
  const key = size ? normalizedJushuitanSize : normalize;
  const matches = entries.filter(entry => entry.status === "ACTIVE" && /^\d{3}$/.test(entry.code) &&
    (size || entry.code !== "044") && (key(entry.name) === key(value) || entry.code === value.trim()));
  return matches.length === 1 ? matches[0] : undefined;
}

export function buildJushuitanProducts(
  sources: JushuitanSource[], mappings: JushuitanMappings, overrides: JushuitanOverrides = {},
): JushuitanResult {
  const issues = sources.flatMap(source => source.issues);
  const rows: (string | number)[][] = [];
  const styles = new Set<string>(), codes = new Set<string>();
  for (const source of sources) {
    const { values: v } = source;
    const issue = (message: string, severity: JushuitanIssue["severity"] = "error") =>
      issues.push({ rowId: source.id, style: v.style || `所选记录 ${source.id}`, severity, message });
    if (!v.style || !source.colors.length || !source.sizes.length || !v.category) continue;
    if (styles.has(normalize(v.style))) { issue("同款号选中了多条记录，请仅保留一条"); continue; }
    styles.add(normalize(v.style));
    const override = overrides[source.id];
    const kind = override?.kind || jushuitanGarmentKind(v.category);
    if (!kind) { issue("无法判断上、下装，请选择号型规则"); continue; }
    const price = (key: "tagPrice" | "vipPrice" | "cost"): number | "" => {
      if (!v[key]) return "";
      const raw = v[key].replace(/[,，¥￥\s]/g, "");
      if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) { issue(`${definitions[key].labels[0]}须为非负金额，最多两位小数`); return ""; }
      return new Decimal(raw).toNumber();
    };
    const tag = price("tagPrice"), vip = price("vipPrice"), cost = price("cost");
    for (const color of source.colors) {
      const colorMap = mappingFor(color, mappings.colors, false);
      if (!colorMap) { issue(`标准颜色「${color}」未找到唯一启用的三位色码，请在颜色映射中维护`); continue; }
      const supplierColor = override?.supplierColors?.[color] ?? defaultJushuitanSupplierColor(source, color);
      if (source.supplierColors.length && !source.supplierColors.includes(supplierColor)) {
        issue(`请选择标准颜色「${color}」对应的供应商颜色`); continue;
      }
      // A stale override must never reintroduce a value that has become unreadable.
      if (!source.supplierColors.length && supplierColor) { issue("供应商颜色已变化，请重新读取选中款号"); continue; }
      for (const size of source.sizes) {
        const sizeMap = mappingFor(size, mappings.sizes, true);
        if (!sizeMap) { issue(`尺码「${size}」未找到唯一启用的三位尺码码，请在尺码映射中维护`); continue; }
        const sizeLabel = jushuitanSizeLabel(sizeMap.name, kind);
        if (!sizeLabel) { issue(`尺码「${sizeMap.name}」不适用模板的 S/M/L 系列或均码号型规则`); continue; }
        const sku = `${v.style}${colorMap.code}${sizeMap.code}`;
        if (codes.has(normalize(sku))) { issue(`商品编码「${sku}」重复，请核对颜色及尺码`); continue; }
        codes.add(normalize(sku));
        rows.push([
          v.style, sku, v.longTitle, v.shortTitle, `${colorMap.name};${sizeMap.name}`, v.category, "", "序缇质造-唯品会",
          v.supplierStyle, "", v.supplierName, "", "", "", "唯品会链接", "启用", "是", "成品", "", "", "", "", "", "",
          v.supplierName, tag, vip, cost, "", "", "", "", cost === "" ? "" : new Decimal(cost).mul("1.2").toDecimalPlaces(2).toNumber(),
          sizeLabel, supplierColor, v.material, v.safety, v.standard,
        ]);
        if (rows.length > jushuitanLimits.skus) throw Error(`一次最多生成 ${jushuitanLimits.skus} 条商品资料，请分批选择`);
      }
    }
  }
  return { rows, issues: [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()], styleCount: styles.size };
}
