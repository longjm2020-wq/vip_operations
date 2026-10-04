import type { SelectionField } from "./selection-layout.js";
import { selectionBaseFields } from "./selection-migration.js";
import { archiveFieldIds as ids } from "./product-archive.js";

export const archiveMappedFields: Record<string, string> = {
  supplierStyleNo: ids.supplierStyle,
  supplyPriceExclTax: ids.unitPrice,
  color: ids.customColor,
  sizeRange: ids.sizeRange,
  material: ids.composition,
};
export function archiveTableFields(
  definitions: {
    id: string;
    name: string;
    type: string;
    options: string[];
    active: boolean;
  }[],
): SelectionField[] {
  const common = selectionBaseFields.map(
    (field) =>
      ({
        ...field,
        label:
          field.key === "xutiStyleNo"
            ? "款号"
            : field.key === "supplyPriceExclTax"
              ? "单品价"
              : field.label,
        type:
          field.key === "images" || field.key === "labelImages"
            ? "image"
            : /Price/.test(field.key)
              ? "currency"
              : field.key === "registrationBatch"
                ? "date"
                : "text",
      }) as SelectionField,
  );
  const core = [
    ["name", "商品名称", "text"],
    ["categoryId", "三级分类", "text"],
    ["brandId", "品牌", "text"],
    ["defaultSupplierId", "默认供应商", "text"],
    ["year", "年份", "number"],
    ["season", "适穿季节", "text"],
    ["status", "商品状态", "text"],
    ["remark", "备注", "text"],
  ].map(
    ([key, label, type]) =>
      ({
        key: "custom:product:" + key,
        label,
        type,
        width: 140,
        custom: true,
      }) as SelectionField,
  );
  const mapped = new Set(Object.values(archiveMappedFields));
  const custom = definitions
    .filter((field) => field.active && !mapped.has(field.id))
    .map(
      (field) =>
        ({
          key: "custom:product:" + field.id,
          label: field.name,
          custom: true,
          width: 140,
          type:
            field.type === "select"
              ? "single"
              : field.type === "number"
                ? "number"
                : field.type === "date"
                  ? "date"
                  : "text",
          options: field.options || [],
        }) as SelectionField,
    );
  return [
    ...common.slice(0, 4),
    core[0],
    core[1],
    ...common.slice(4),
    ...core.slice(2),
    ...custom,
  ];
}
