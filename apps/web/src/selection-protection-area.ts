import type { ProtectionRegion } from "../../../packages/contracts/src/selection-protection.js";

type ProtectionArea = Pick<ProtectionRegion, "scope" | "rowIds" | "columnKeys">;

export function normalizeProtectionArea<T extends ProtectionArea>(area: T): T {
  return {
    ...area,
    rowIds: area.scope === "columns" || area.scope === "sheet" ? [] : [...new Set(area.rowIds)],
    columnKeys: area.scope === "rows" || area.scope === "sheet" ? [] : [...new Set(area.columnKeys)],
  };
}

export function selectionProtectionArea({
  rows, columns, selectedCells, selectedRows, selectedColumnKeys, emptyScope,
}: {
  rows: { _key: string; id?: unknown }[];
  columns: { key: string }[];
  selectedCells: ReadonlySet<string>;
  selectedRows: readonly string[];
  selectedColumnKeys: readonly string[];
  emptyScope: "cells" | "sheet";
}): ProtectionArea {
  // Axis selections also contain visible cell IDs. Preserve the axis intent:
  // columns must not be frozen to the current page, nor rows to current fields.
  const scope = selectedColumnKeys.length ? "columns"
    : selectedRows.length ? "rows"
      : selectedCells.size ? "cells" : emptyScope;
  const rowKeys = scope === "rows" ? selectedRows
    : scope === "cells" ? [...selectedCells].map(id => id.split("::")[0]) : [];
  const rowByKey = new Map(rows.map(row => [row._key, row]));
  const rowIds = [...new Set(rowKeys)].map(key => {
    const id = rowByKey.get(key)?.id;
    if (!id) throw Error("请先保存选中行，再设置区域");
    return String(id);
  });
  const columnKeys = [...new Set(scope === "columns" ? selectedColumnKeys
    : scope === "cells" ? [...selectedCells].map(id => id.split("::")[1]) : [])];
  const availableKeys = new Set(columns.map(column => column.key));
  if (columnKeys.some(key => !availableKeys.has(key)))
    throw Error("选中字段已变化，请重新选择区域");
  return { scope, rowIds, columnKeys };
}
