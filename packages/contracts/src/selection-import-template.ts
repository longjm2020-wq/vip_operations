import type { SelectionField } from "./selection-layout.js";

/** Workbook labels are stable input names, never client-selected storage keys. */
export type SelectionImportTemplateField = {
  label: string;
  type: NonNullable<SelectionField["type"]>;
  builtinKey?: string;
  readonly?: true;
};

export const selectionImportTemplateFields: readonly SelectionImportTemplateField[] = [
  { label: "创建时间", type: "createdTime", builtinKey: "registrationBatch", readonly: true },
  { label: "图片", type: "image", builtinKey: "images" },
  { label: "序缇款号", type: "text", builtinKey: "xutiStyleNo" },
  { label: "三级类目", type: "text" },
  { label: "供应商款号", type: "text", builtinKey: "supplierStyleNo" },
  { label: "供应商编码", type: "text", builtinKey: "supplierCode" },
  { label: "供应商颜色", type: "text", builtinKey: "color" },
  { label: "标准颜色", type: "text" },
  { label: "尺码范围", type: "text", builtinKey: "sizeRange" },
  { label: "成分", type: "text", builtinKey: "material" },
  { label: "洗唛/吊牌图", type: "image", builtinKey: "labelImages" },
  { label: "安全类别", type: "text" },
  { label: "执行标准", type: "text" },
  { label: "洗涤标志核对", type: "text" },
  { label: "面料材质核对", type: "text" },
  { label: "是否豁免二次车缝", type: "text" },
  { label: "衣服整改措施", type: "text" },
  { label: "供货价（不含税）", type: "currency", builtinKey: "supplyPriceExclTax" },
  { label: "唯品价", type: "currency", builtinKey: "vipPrice" },
  { label: "直播价", type: "currency", builtinKey: "livePrice" },
  { label: "吊牌价", type: "currency", builtinKey: "tagPrice" },
  { label: "长标题", type: "text" },
  { label: "短标题", type: "text" },
  { label: "尺码表", type: "text" },
];

const templateByLabel = new Map(selectionImportTemplateFields.map(field => [field.label, field]));
const aliases = new Map([
  ["颜色", "供应商颜色"],
  ["材质", "成分"],
  ["材质成分", "成分"],
  ["供货价(不含税)", "供货价（不含税）"],
]);
const legacyBatch: SelectionImportTemplateField = { label: "登记批次", type: "date", builtinKey: "registrationBatch" };

/** The legacy writable batch remains import-compatible; 创建时间 is always read-only. */
export function selectionImportHeader(header: string): SelectionImportTemplateField | undefined {
  const label = header.trim();
  return label === legacyBatch.label ? legacyBatch : templateByLabel.get(aliases.get(label) || label);
}
