import type { OfficeClipboardPayload } from "./selection-office-clipboard.js";
import { loadExcelJS } from "./exceljs-loader.js";

export async function officeClipboardWorkbook(payload: OfficeClipboardPayload) {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("表格选区");
  sheet.columns = Array.from({ length: payload.cells[0]?.length || 0 }, () => ({ width: 22 }));
  for (let rowIndex = 0; rowIndex < payload.cells.length; rowIndex++) {
    const cells = payload.cells[rowIndex];
    const row = sheet.addRow(cells.map(cell => cell.image ? "" : cell.text));
    row.height = Math.min(180, Math.max(cells.some(cell => cell.image) ? 78 : 24,
      ...cells.map(cell => Math.min(10, cell.text.split(/\r\n?|\n/).length) * 15)));
    row.eachCell({ includeEmpty: true }, cell => {
      cell.numFmt = "@";
      cell.alignment = { vertical: "middle", wrapText: true };
    });
    for (let columnIndex = 0; columnIndex < cells.length; columnIndex++) {
      const cell = cells[columnIndex];
      if (!cell.image) continue;
      const picture = payload.images.get(`${cell.image.rowId}::${cell.image.columnKey}`);
      if (!picture?.jpeg) throw Error("图片资料不完整，请重新准备后下载");
      const bytes = new Uint8Array(await picture.jpeg.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      const imageId = workbook.addImage({ base64: btoa(binary), extension: "jpeg" });
      sheet.addImage(imageId, { tl: { col: columnIndex + .04, row: rowIndex + .04 },
        ext: { width: picture.width, height: picture.height }, editAs: "oneCell" });
    }
  }
  const bytes = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(bytes)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
