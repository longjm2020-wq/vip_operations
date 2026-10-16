import type { Row } from "./shared";
import { loadExcelJS } from "./exceljs-loader";
export type SheetDownload = { url: string; fileName: string };
export async function prepareSheetDownload(
  name: string,
  records: Row[],
): Promise<SheetDownload> {
  const Excel = await loadExcelJS();
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
  return { url, fileName: name + ".xlsx" };
}
export function triggerSheetDownload(file: SheetDownload) {
  const link = document.createElement("a");
  link.href = file.url;
  link.download = file.fileName;
  link.hidden = true;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}
export function releaseSheetDownload(file: SheetDownload) {
  // Allow the browser to finish opening a download before releasing its source.
  setTimeout(() => URL.revokeObjectURL(file.url), 60_000);
}
export async function downloadSheet(name: string, records: Row[]) {
  const file = await prepareSheetDownload(name, records);
  try {
    triggerSheetDownload(file);
  } finally {
    releaseSheetDownload(file);
  }
}
