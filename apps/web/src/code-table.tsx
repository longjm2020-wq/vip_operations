import { useMemo } from "react";
import { Table as AntTable, type TableProps } from "antd";
import { CopyableCode, productCodeLabel } from "./copyable-code";

function codeColumns<T extends object>(columns: TableProps<T>["columns"]): TableProps<T>["columns"] {
  return columns?.map(column => {
    if ("children" in column) return { ...column, children: codeColumns(column.children)! };
    if (!productCodeLabel(column.title, column.dataIndex)) return column;
    return { ...column, render: (value, row, index) => {
      const rendered = column.render ? column.render(value, row, index) : value;
      // Only decorate the displayed value. Custom links, masked cells and editors
      // manage their own copy action; never recover hidden values from the row.
      return typeof rendered === "string" || typeof rendered === "number"
        ? <CopyableCode value={rendered} label={typeof column.title === "string" ? column.title : "编号"}>{rendered}</CopyableCode>
        : rendered;
    } };
  });
}

function CodeTable<T extends object>(props: TableProps<T>) {
  const columns = useMemo(() => codeColumns(props.columns), [props.columns]);
  return <AntTable<T> {...props} columns={columns} />;
}

export const Table = Object.assign(CodeTable, { Summary: AntTable.Summary });
