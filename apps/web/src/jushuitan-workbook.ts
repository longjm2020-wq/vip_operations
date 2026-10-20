import { loadExcelJS } from "./exceljs-loader.js";
import { jushuitanHeaders } from "./jushuitan-products.js";

export async function createJushuitanWorkbook(rows: (string | number)[][]) {
  if (!rows.length || rows.some(row => row.length !== jushuitanHeaders.length)) throw Error("建档资料为空或格式不完整，请重新生成");
  const { Workbook } = await loadExcelJS();
  const book = new Workbook();
  const sheet = book.addWorksheet("商品资料");
  sheet.columns = jushuitanHeaders.map((header, index) => ({
    header, width: index === 35 ? 48 : index === 2 ? 42 : [1, 4, 33].includes(index) ? 28 : 20,
    style: { numFmt: [25, 26, 27, 32].includes(index) ? "0.00" : "@" },
  }));
  sheet.addRows(rows);
  sheet.views = [{ state: "frozen", ySplit: 1, xSplit: 2 }];
  sheet.autoFilter = { from: "A1", to: `AL${sheet.rowCount}` };
  sheet.getRow(1).font = { bold: true, color: { argb: "FF46352A" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2E5" } };
  sheet.getRow(1).height = 28;
  sheet.eachRow(row => { row.alignment = { vertical: "top", wrapText: true }; });
  return book;
}

export async function downloadJushuitanWorkbook(rows: (string | number)[][]) {
  const book = await createJushuitanWorkbook(rows);
  const buffer = await book.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `聚水潭商品建档_${new Date().toISOString().slice(0, 10)}.xlsx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
