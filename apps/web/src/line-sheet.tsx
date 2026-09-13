import { Sheet } from "./sheet";
import {
  SheetColumn,
  SheetRow,
  resolveCell,
  validateSheet,
} from "./sheet-data";
import { BatchField, useSheetColumns } from "./batch-editor";
export const purchaseFields: BatchField[] = [
  { key: "skuId", label: "SKU", required: true, source: "/skus" },
  {
    key: "orderedQty",
    label: "采购数量",
    required: true,
    type: "number",
    min: 1,
  },
  { key: "unitCost", label: "单价", required: true, type: "money" },
];
export const receiptFields: BatchField[] = [
  { key: "skuCode", label: "SKU", readonly: true },
  { key: "receivedQty", label: "本次到货", required: true, type: "number" },
  { key: "qualifiedQty", label: "合格", required: true, type: "number" },
  { key: "damagedQty", label: "次品", required: true, type: "number" },
  { key: "shortageQty", label: "少货", required: true, type: "number" },
];
export function LineSheet({
  value = [],
  onChange,
  receipt = false,
  fields,
  title,
}: {
  value?: SheetRow[];
  onChange?: (v: SheetRow[]) => void;
  receipt?: boolean;
  fields?: BatchField[];
  title?: string;
}) {
  const { columns, loading, error } = useSheetColumns(
    fields || (receipt ? receiptFields : purchaseFields),
  );
  if (loading) return <p>加载表格选项…</p>;
  if (error) return <p role="alert">关联资料加载失败，请刷新后重试。</p>;
  return (
    <Sheet
      title={title || (receipt ? "入库明细" : "采购明细")}
      columns={columns}
      value={value}
      fixed={receipt}
      defaults={receipt ? {} : { orderedQty: 1, unitCost: "0.00" }}
      onChange={(next) =>
        onChange?.(
          next.map((r) =>
            Object.fromEntries(
              Object.entries(r).map(([k, v]) => {
                const c = columns.find((c) => c.key === k);
                if (!c) return [k, v];
                try {
                  return [k, resolveCell(v, c)];
                } catch {
                  return [k, v];
                }
              }),
            ),
          ),
        )
      }
    />
  );
}
export function lineRule(columns: SheetColumn[]) {
  return {
    validator: async (_: unknown, value: SheetRow[]) => {
      if (!value?.length) throw Error("请至少填写一行明细");
      const { errors } = validateSheet(value, columns);
      const first = Object.entries(errors)[0];
      if (first) {
        const [r, key] = first[0].split(":");
        throw Error(
          `第${Number(r) + 1}行 ${columns.find((c) => c.key === key)?.label}：${first[1]}`,
        );
      }
    },
  };
}
