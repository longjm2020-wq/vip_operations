import type { Row } from "./shared";
export async function downloadSheet(name: string, records: Row[]) {
  const Excel = (await import("exceljs")).default;
  const book = new Excel.Workbook();
  const sheet = book.addWorksheet("数据");
  const keys = Object.keys(records[0] || {});
  sheet.columns = keys.map((key) => ({ header: key, key, width: 22 }));
  for (const r of records) sheet.addRow(r);
  const buffer = await book.xlsx.writeBuffer();
  const url = URL.createObjectURL(
    new Blob([buffer as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name + ".xlsx";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
