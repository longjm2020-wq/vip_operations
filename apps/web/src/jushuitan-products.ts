import { Decimal } from "decimal.js";
import type { SelectionField } from "../../../packages/contracts/src/selection-layout.js";
import {
  registrationDefinitions as definitions, registrationLimits as jushuitanLimits,
  readRegistrationSources, normalizedRegistrationSize as normalizedJushuitanSize,
  defaultRegistrationSupplierColor as defaultJushuitanSupplierColor, registrationMappingFor as mappingFor,
  normalizeRegistrationValue as normalize, type RegistrationKey as SourceKey,
  type RegistrationSource as JushuitanSource, type RegistrationMapping as JushuitanMapping,
  type RegistrationMappings as JushuitanMappings, type RegistrationIssue as JushuitanIssue,
  type RegistrationResult as JushuitanResult,
} from "./product-registration-sources.js";
export { jushuitanLimits, normalizedJushuitanSize, defaultJushuitanSupplierColor };
export type { JushuitanSource, JushuitanMapping, JushuitanMappings, JushuitanIssue, JushuitanResult };

// Positional columns are intentional: the supplied template repeats 供应商名称.
export const jushuitanHeaders = [
  "款式编码", "商品编码", "商品名称", "商品简称", "颜色及规格", "三级类目", "图片", "品牌",
  "供应商款式编码", "国标码", "供应商名称", "分类", "虚拟分类", "商品标签", "备注", "商品状态",
  "库存同步", "商品属性", "重量", "长", "宽", "高", "体积", "单位", "供应商名称", "市场|吊牌价",
  "基本售价", "成本价", "其它价格1", "其它价格2", "其它价格3", "其它价格4", "其它价格5",
  "其它属性1", "其它属性2", "成分", "安全类别", "执行标准",
] as const;
export type JushuitanKind = "upper" | "lower";
export type JushuitanOverride = { kind?: JushuitanKind; supplierColors?: Record<string, string> };
export type JushuitanOverrides = Record<string, JushuitanOverride>;
export function readJushuitanSources(
  rows: Record<string, any>[], fields: SelectionField[], references: Record<string, { id: string; name: string }[]> = {},
): JushuitanSource[] {
  return readRegistrationSources(rows, fields, Object.keys(definitions) as SourceKey[], references);
}

export function jushuitanGarmentKind(category: string): JushuitanKind | undefined {
  if (/连衣裙|礼服/.test(category)) return "upper";
  if (/裤|半截裙|半身裙|下装/.test(category)) return "lower";
  if (/上衣|上装|衬衫|T恤|T恤衫|背心|马[夹甲]|大衣|风衣|外套|卫衣|毛衫|绒衫|针织衫|毛衣|打底衫|羽绒服|棉衣|夹克|皮衣|皮草|西服/i.test(category)) return "upper";
  return undefined;
}

export function jushuitanSizeLabel(size: string, kind: JushuitanKind): string | undefined {
  const value = normalizedJushuitanSize(size);
  let step = ({ S: -1, M: 0, L: 1, XL: 2, XS: -2, F: 0 } as Record<string, number>)[value];
  if (step === undefined && /^[2-8]XL$/.test(value)) step = Number(value[0]) + 1;
  if (step === undefined && /^[2-5]XS$/.test(value)) step = -Number(value[0]) - 1;
  return step === undefined ? undefined : `${160 + step * 5}/${(kind === "lower" ? 68 : 84) + step * 4}A(${value})`;
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
