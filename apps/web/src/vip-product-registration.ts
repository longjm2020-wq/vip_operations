import { Decimal } from "decimal.js";
import type { SelectionField } from "../../../packages/contracts/src/selection-layout.js";
import {
  readRegistrationSources, registrationLimits, registrationMappingFor, normalizeRegistrationValue,
  defaultRegistrationSupplierColor, type RegistrationSource, type RegistrationMappings, type RegistrationResult,
} from "./product-registration-sources.js";

export const vipRegistrationHeaders = [
  "品牌名称", "款号", "货号", "条形码", "商品名称", "副标题", "商品类目", "标准尺码", "自定义尺码", "标准颜色",
  "自定义颜色", "市场价", "商品类别", "产地", "配件备注", "重量(g)", "毛重(g)", "是否易碎品", "是否大件",
  "是否贵重品", "是否美妆", "洗涤说明", "关键字", "特点描述", "是否原箱发货", "带包装长", "带包装宽", "带包装高", "带包装重量",
] as const;
const vipSourceKeys = ["style", "colors", "sizes", "supplierColors", "category", "longTitle", "tagPrice"] as const;
export type VipRegistrationSource = RegistrationSource<(typeof vipSourceKeys)[number]>;
export type VipRegistrationOverrides = Record<string, { supplierColors?: Record<string, string> }>;
export function readVipRegistrationSources(
  rows: Record<string, any>[], fields: SelectionField[], references: Record<string, { id: string; name: string }[]> = {},
) {
  return readRegistrationSources(rows, fields, vipSourceKeys, references);
}

export function buildVipRegistration(
  sources: VipRegistrationSource[], mappings: RegistrationMappings, overrides: VipRegistrationOverrides = {},
): RegistrationResult {
  if (sources.length > registrationLimits.styles) throw Error(`一次最多选择 ${registrationLimits.styles} 款，请分批生成`);
  const issues = sources.flatMap(source => source.issues);
  const rows: (string | number)[][] = [];
  const styles = new Set<string>(), barcodes = new Set<string>();
  for (const source of sources) {
    const { values: v } = source;
    const issue = (message: string) => issues.push({ rowId: source.id, style: v.style || `所选记录 ${source.id}`, severity: "error", message });
    if (!v.style || !source.colors.length || !source.sizes.length || !v.category) continue;
    if (styles.has(normalizeRegistrationValue(v.style))) { issue("同款号选中了多条记录，请仅保留一条"); continue; }
    styles.add(normalizeRegistrationValue(v.style));
    let price: number | "" = "";
    if (v.tagPrice) {
      const raw = v.tagPrice.replace(/[,，¥￥\s]/g, "");
      if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) { issue("吊牌价须为非负金额，最多两位小数"); continue; }
      price = new Decimal(raw).toNumber();
    }
    for (const color of source.colors) {
      const colorMap = registrationMappingFor(color, mappings.colors, false);
      if (!colorMap) { issue(`标准颜色「${color}」未找到唯一启用的三位色码，请在颜色映射中维护`); continue; }
      const supplierColor = overrides[source.id]?.supplierColors?.[color] ?? defaultRegistrationSupplierColor(source, color);
      if (source.supplierColors.length && !source.supplierColors.includes(supplierColor)) {
        issue(`请选择标准颜色「${color}」对应的供应商颜色`); continue;
      }
      if (!source.supplierColors.length && supplierColor) { issue("供应商颜色已变化，请重新读取选中款号"); continue; }
      const itemNo = `${v.style}${colorMap.code}`;
      for (const size of source.sizes) {
        const sizeMap = registrationMappingFor(size, mappings.sizes, true);
        if (!sizeMap) { issue(`尺码「${size}」未找到唯一启用的三位尺码码，请在尺码映射中维护`); continue; }
        const barcode = `${itemNo}${sizeMap.code}`;
        if (barcodes.has(normalizeRegistrationValue(barcode))) { issue(`条形码「${barcode}」重复，请核对颜色及尺码`); continue; }
        barcodes.add(normalizeRegistrationValue(barcode));
        // The reference deliberately leaves 标准尺码、标准颜色 and 副标题 empty.
        rows.push(["序缇", v.style, itemNo, barcode, v.longTitle, "", v.category, "", size, "", supplierColor, price, "普通商品",
          "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
        if (rows.length > registrationLimits.skus) throw Error(`一次最多生成 ${registrationLimits.skus} 条商品资料，请分批选择`);
      }
    }
  }
  return { rows, issues: [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()], styleCount: styles.size };
}
