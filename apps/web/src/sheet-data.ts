export type SheetRow = Record<string, any>;
export type SheetColumn = {
  key: string;
  label: string;
  required?: boolean;
  editor?: "select" | "textarea";
  unique?: boolean;
  type?: "number" | "money" | "status";
  options?: { value: string; label: string; aliases?: string[] }[];
  readonly?: boolean | ((row: SheetRow) => boolean);
  min?: number;
  max?: number;
};
export const MAX_SHEET_ROWS = 500;
export function parseDelimited(text: string, delimiter = "\t"): string[][] {
  const result: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted || !cell) quoted = !quoted;
      else cell += ch;
    } else if (ch === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      result.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) throw Error("引号未闭合，请检查表格内容");
  row.push(cell);
  result.push(row);
  while (result.length && result.at(-1)!.every((x) => x === "")) result.pop();
  if (result.length > MAX_SHEET_ROWS + 1)
    throw Error(`每批最多 ${MAX_SHEET_ROWS} 行，请分批导入`);
  return result;
}
export function displayCell(value: any, column: SheetColumn): string {
  if (value == null) return "";
  return (
    column.options?.find((o) => o.value === String(value))?.label ??
    String(value)
  );
}
export function resolveCell(raw: any, column: SheetColumn): any {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (column.options) {
    // Prefer explicit codes/IDs; duplicate names must not silently choose a record.
    const exact = column.options.find((o) => o.value === value);
    if (exact) return exact.value;
    const matches = column.options.filter(
      (o) => o.label === value || o.aliases?.includes(value),
    );
    if (matches.length === 1) return matches[0].value;
    throw Error(
      matches.length
        ? "名称重复，请使用编码或完整选项"
        : "找不到对应选项，请先建立关联资料",
    );
  }
  if (column.type === "number") {
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw Error("请输入有效整数");
    const n = Number(value);
    if (n < (column.min ?? 0) || n > (column.max ?? Number.MAX_SAFE_INTEGER))
      throw Error("数值超出允许范围");
    return n;
  }
  if (column.type === "money") {
    if (!/^\d+(\.\d{1,2})?$/.test(value))
      throw Error("金额须为非负数，最多两位小数");
    return value;
  }
  return value;
}
export function validateSheet(rows: SheetRow[], columns: SheetColumn[]) {
  const errors: Record<string, string> = {};
  const values = rows.map((row, i) => {
    const next = { ...row };
    for (const col of columns) {
      try {
        next[col.key] = resolveCell(row[col.key], col);
        if (col.required && next[col.key] == null)
          throw Error("必填项不能为空");
      } catch (e) {
        errors[`${i}:${col.key}`] = (e as Error).message;
      }
    }
    return next;
  });
  columns
    .filter((c) => c.unique)
    .forEach((col) => {
      values.forEach((row, i) => {
        if (
          row[col.key] &&
          values.some((other, j) => j !== i && other[col.key] === row[col.key])
        )
          errors[`${i}:${col.key}`] = "该选项只能选择一次";
      });
    });
  return { values, errors };
}
export function applyMatrix(
  rows: SheetRow[],
  columns: SheetColumn[],
  matrix: string[][],
  startRow: number,
  startCol: number,
  fixed = false,
) {
  if (startRow + matrix.length > (fixed ? rows.length : MAX_SHEET_ROWS))
    throw Error("粘贴行数超出范围");
  if (matrix.some((r) => startCol + r.length > columns.length))
    throw Error("粘贴列数超出范围，请从正确的列开始");
  const next = rows.map((r) => ({ ...r }));
  matrix.forEach((cells, r) => {
    const target = next[startRow + r] ?? {};
    next[startRow + r] = target;
    cells.forEach((value, c) => {
      const col = columns[startCol + c];
      const locked =
        typeof col.readonly === "function"
          ? col.readonly(target)
          : col.readonly;
      if (locked) return;
      target[col.key] = value;
    });
  });
  return next;
}
