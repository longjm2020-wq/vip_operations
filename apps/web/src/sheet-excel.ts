import {
  MAX_SHEET_ROWS,
  SheetColumn,
  SheetRow,
  displayCell,
  parseDelimited,
} from "./sheet-data.js";
export async function readWorkbook(file: File) {
  if (file.size > 5 * 1024 * 1024)
    throw Error("文件不能超过 5MB，请拆分后导入");
  if (/\.csv$/i.test(file.name))
    return [{ name: file.name, rows: parseDelimited(await file.text(), ",") }];
  if (!/\.xlsx$/i.test(file.name))
    throw Error("支持 .xlsx 和 UTF-8 CSV；旧版 .xls 请另存为 .xlsx");
  const { Workbook } = (await import("exceljs")).default;
  const book = new Workbook();
  await book.xlsx.load(await file.arrayBuffer());
  return book.worksheets
    .map((sheet) => {
      if (sheet.rowCount > MAX_SHEET_ROWS + 1 || sheet.columnCount > 100)
        throw Error("表格超过 500 行或 100 列，请拆分并清除多余格式");
      const rows: string[][] = [];
      sheet.eachRow({ includeEmpty: true }, (row) => {
        const values: string[] = [];
        for (let c = 1; c <= sheet.columnCount; c++) {
          const cell = row.getCell(c),
            value = cell.value;
          if (
            value &&
            typeof value === "object" &&
            ("formula" in value || "sharedFormula" in value)
          )
            throw Error(
              `工作表「${sheet.name}」${cell.address} 含公式，请粘贴为值后导入`,
            );
          // Excel may store codes as numbers with a zero-padding display format.
          values.push(
            typeof value === "number" && /^0+$/.test(cell.numFmt || "")
              ? String(value).padStart(cell.numFmt.length, "0")
              : cell.text,
          );
        }
        rows.push(values);
      });
      while (rows.length && rows.at(-1)!.every((v) => !v)) rows.pop();
      return { name: sheet.name, rows };
    })
    .filter((s) => s.rows.length);
}
export async function downloadWorkbook(
  name: string,
  columns: SheetColumn[],
  rows: SheetRow[] = [],
) {
  const { Workbook } = (await import("exceljs")).default;
  const book = new Workbook(),
    sheet = book.addWorksheet("数据");
  sheet.columns = columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: 24,
    style: { numFmt: "@" },
  }));
  for (const row of rows)
    sheet.addRow(
      Object.fromEntries(
        columns.map((c) => [c.key, displayCell(row[c.key], c)]),
      ),
    );
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF28685F" },
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const notes = book.addWorksheet("填写说明");
  notes.addRows([
    ["首行是列名；每批最多500行；编码和条码请使用文本格式；公式请转为值。"],
    ["导入只进入待保存表格，不会自动修改线上数据。"],
    ...columns.map((c) => [
      c.label,
      c.required ? "必填" : "选填",
      c.options
        ? c.options
            .map((o) => o.label)
            .join("；")
            .slice(0, 30000)
        : c.type || "文本",
    ]),
  ]);
  const buffer = await book.xlsx.writeBuffer();
  const url = URL.createObjectURL(
    new Blob([buffer as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name + ".xlsx";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
