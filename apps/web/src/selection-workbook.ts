import type ExcelJS from "exceljs";

type Row = Record<string, any>;
export const selectionSheetColumns = [
  ["registrationBatch", "登记批次"], ["images", "图片"], ["labelImages", "洗唛/吊牌图"], ["xutiStyleNo", "序缇款号"],
  ["supplierStyleNo", "供应商款号"], ["supplierCode", "供应商编码"], ["color", "颜色"],
  ["sizeRange", "尺码范围"], ["material", "材质"], ["supplyPriceExclTax", "供货价（不含税）"],
  ["vipPrice", "唯品价"], ["livePrice", "直播价"], ["tagPrice", "吊牌价"],
] as const;
const priceKeys = new Set(["supplyPriceExclTax", "vipPrice", "livePrice", "tagPrice"]);
function styleSheet(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF805239" } };
  sheet.getRow(1).height = 26;
  sheet.eachRow(row => { row.alignment = { vertical: "top", wrapText: true }; });
}
export async function createSelectionWorkbook(records: Row[] = []) {
  const { Workbook } = (await import("exceljs")).default;
  const book = new Workbook();
  const sheet = book.addWorksheet("选款资料");
  sheet.columns = selectionSheetColumns.map(([key, header]) => ({ key, header, width: key === "material" ? 32 : 20, style: { numFmt: "@" } }));
  const pictures = book.addWorksheet("图片明细");
  pictures.columns = [{ key: "style", header: "序缇款号", width: 24 }, { key: "color", header: "颜色", width: 18 }, { key: "url", header: "图片URL", width: 70 }].map(c => ({ ...c, style: { numFmt: "@" } }));
  const labels = book.addWorksheet("洗唛吊牌图明细");
  labels.columns = [{ key: "style", header: "序缇款号", width: 24 }, { key: "url", header: "图片URL", width: 70 }].map(c => ({ ...c, style: { numFmt: "@" } }));
  let dataSheet: ExcelJS.Worksheet | undefined;
  let imageNumber = 0;
  const codes = new Set<string>();
  for (const record of records) {
    const style = String(record.xutiStyleNo || "").trim();
    if (!style) throw Error("请先为要导出的每款填写序缇款号");
    if (codes.has(style)) throw Error(`序缇款号「${style}」存在多条记录，请勾选唯一款式后导出`);
    codes.add(style);
    const values = Object.fromEntries(selectionSheetColumns.map(([key]) => [key, key === "images" ? (record.images?.length ? "见图片明细" : "") : key === "labelImages" ? (record.labelImages?.length ? "见洗唛吊牌图明细" : "") : key === "registrationBatch" ? String(record[key] || "").slice(0, 10) : String(record[key] ?? "")]));
    values.xutiStyleNo = style;
    sheet.addRow(values);
    for (const image of record.images || []) {
      let url = String(image.url || "");
      if (url.startsWith("data:image/")) {
        // XLSX cells are limited to 32767 characters. Preserve legacy inline images in chunks.
        dataSheet ||= book.addWorksheet("图片内容", { state: "hidden" });
        const reference = `内嵌图片:${++imageNumber}`;
        for (let offset = 0; offset < url.length; offset += 30000) dataSheet.addRow([reference, offset / 30000, url.slice(offset, offset + 30000)]);
        url = reference;
      }
      pictures.addRow({ style, color: image.color || "", url });
    }
    for (const image of record.labelImages || []) {
      let url = String(image.url || "");
      if (url.startsWith("data:image/")) {
        dataSheet ||= book.addWorksheet("图片内容", { state: "hidden" });
        const reference = `内嵌图片:${++imageNumber}`;
        for (let offset = 0; offset < url.length; offset += 30000) dataSheet.addRow([reference, offset / 30000, url.slice(offset, offset + 30000)]);
        url = reference;
      }
      labels.addRow({ style, url });
    }
  }
  styleSheet(sheet); styleSheet(pictures); styleSheet(labels);
  const notes = book.addWorksheet("填写说明");
  notes.getColumn(1).width = 110;
  notes.addRows([
    ["一行一款，以序缇款号匹配；款号必填，保留文本格式（包括前导零）。"],
    ["已有款更新、新款新增。空白字段保留原值，不用于清空；表内或系统中同款重复时请先核对。"],
    ["日期为 YYYY-MM-DD；颜色、尺码用 / 分隔；金额为非负数字，最多两位小数。"],
    ["多图在「图片明细」中逐图填写序缇款号、颜色、图片URL；图片颜色必须在该款颜色字段中。"],
    ["也可在主表图片列逐行填写「颜色 | https://图片地址」；不填颜色时可仅填网址。"],
    ["图片明细与主表图片不能同时填写同款；填写图片将替换该款原图片，留空则保留。"],
    ["洗唛/吊牌图可在「洗唛吊牌图明细」逐图填写款号和图片URL；填写后替换该款原洗唛/吊牌图，留空保留。"],
    ["系统内图片地址须登录同一系统查看。旧版内嵌图片自动保存在隐藏工作表中，请保留该表。"],
    ["仅支持本模板的数据与图片地址，不解析 Excel 浮动图片。公式请先粘贴为值。"],
    ["每次导入最多 500 款、文件 20 MB；导入预览确认后整批写入，冲突则整批不写入。"],
    ["自定义列、单元格填色和列布局不包含在此模板中；更新时保留系统现有设置。"],
  ]);
  return book;
}
export async function downloadSelectionWorkbook(records: Row[] = [], template = false) {
  const book = await createSelectionWorkbook(records);
  const buffer = await book.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a"); link.href = url; link.download = template ? "选款登记导入模板.xlsx" : "选款登记按款资料.xlsx"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) throw Error(`${cell.address} 含公式，请先粘贴为值`);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && /^0+$/.test(cell.numFmt || "")) return String(value).padStart(cell.numFmt.length, "0");
  return cell.text.trim();
}
export async function parseSelectionWorkbook(buffer: ArrayBuffer) {
  const { Workbook } = (await import("exceljs")).default;
  const book = new Workbook(); await book.xlsx.load(buffer);
  const sheet = book.getWorksheet("选款资料");
  if (!sheet) throw Error("缺少「选款资料」工作表，请使用下载的模板");
  if (sheet.rowCount > 501 || sheet.columnCount > 30) throw Error("每次导入最多 500 款，请拆分文件并清除多余格式");
  if (sheet.getImages().length) throw Error("请在图片明细填写图片地址，不支持 Excel 浮动图片");
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, index) => { const name = cellText(cell); if (headers.has(name)) throw Error(`表头「${name}」重复`); headers.set(name, index); });
  if (!headers.has("序缇款号")) throw Error("缺少序缇款号列");
  for (const header of headers.keys()) if (!selectionSheetColumns.some(([, label]) => label === header)) throw Error(`无法识别表头「${header}」，请使用下载的模板`);
  const result: Row[] = [];
  const byStyle = new Map<string, Row>();
  const data = new Map<string, Map<number, string>>();
  book.getWorksheet("图片内容")?.eachRow(row => {
    const key = cellText(row.getCell(1)), offset = Number(cellText(row.getCell(2))), chunk = cellText(row.getCell(3));
    if (!Number.isInteger(offset) || offset < 0 || offset > 50) throw Error("内嵌图片内容损坏");
    const chunks = data.get(key) || new Map<number, string>();
    if (chunks.has(offset)) throw Error("内嵌图片内容重复");
    chunks.set(offset, chunk); data.set(key, chunks);
  });
  const imageValue = (color: string, url: string) => {
    if (url.startsWith("内嵌图片:")) {
      const chunks = data.get(url); if (!chunks || [...chunks.keys()].some((_, i) => !chunks.has(i))) throw Error("内嵌图片内容缺失");
      url = [...chunks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join("");
    }
    if (!/^https?:\/\//i.test(url) && !/^\/api\/v1\/style-selections\/images\/[0-9a-f-]{36}(?:\?tableId=[1-9]\d*)?$/i.test(url) && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) throw Error("图片URL须为 http(s) 网址或本系统导出的图片地址");
    if (url.length > 1500000) throw Error("单张内嵌图片过大");
    return { id: crypto.randomUUID(), color: color.trim(), url };
  };
  for (let r = 2; r <= sheet.rowCount; r++) {
    const record: Row = {};
    for (const [key, label] of selectionSheetColumns) {
      const index = headers.get(label); if (!index) continue;
      let text = cellText(sheet.getRow(r).getCell(index)); if (!text || (key === "images" && text === "见图片明细") || (key === "labelImages" && text === "见洗唛吊牌图明细")) continue;
      if (priceKeys.has(key)) { text = text.replace(/[￥¥,，\s]/g, ""); if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) throw Error(`第 ${r} 行${label}应为非负金额，最多两位小数`); }
      if (key === "registrationBatch" && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text)) throw Error(`第 ${r} 行日期应为有效的 YYYY-MM-DD`);
      if (key === "color" || key === "sizeRange") text = [...new Set(text.split("/").map(v => v.trim()).filter(Boolean))].join("/");
      record[key] = key === "images" ? text.split(/\r?\n/).filter(Boolean).map(line => { const i = line.indexOf(" | "); return imageValue(i < 0 ? "" : line.slice(0, i), i < 0 ? line.trim() : line.slice(i + 3).trim()); }) : key === "labelImages" ? text.split(/\r?\n/).filter(Boolean).map(line => imageValue("", line.trim())) : text;
    }
    if (!Object.keys(record).length) continue;
    if (!record.xutiStyleNo) throw Error(`第 ${r} 行缺少序缇款号`);
    if (byStyle.has(record.xutiStyleNo)) throw Error(`序缇款号「${record.xutiStyleNo}」在文件中重复`);
    result.push(record); byStyle.set(record.xutiStyleNo, record);
  }
  const pictures = book.getWorksheet("图片明细");
  if (pictures) {
    if (["序缇款号", "颜色", "图片URL"].some((label, i) => cellText(pictures.getRow(1).getCell(i + 1)) !== label) || pictures.columnCount > 3) throw Error("图片明细表头应依次为：序缇款号、颜色、图片URL");
    if (pictures.getImages().length) throw Error("请在图片明细填写图片地址，不支持 Excel 浮动图片");
    const seen = new Set<string>();
    for (let r = 2; r <= pictures.rowCount; r++) {
      const style = cellText(pictures.getRow(r).getCell(1)), color = cellText(pictures.getRow(r).getCell(2)), url = cellText(pictures.getRow(r).getCell(3));
      if (!style && !color && !url) continue;
      const record = byStyle.get(style); if (!record || !url) throw Error(`图片明细第 ${r} 行缺少对应款号或图片URL`);
      if (!seen.has(style)) { if (record.images) throw Error(`「${style}」的图片请只填写在主表或图片明细其中一处`); record.images = []; seen.add(style); }
      record.images.push(imageValue(color, url));
    }
  }
  const labels = book.getWorksheet("洗唛吊牌图明细");
  if (labels) {
    if (["序缇款号", "图片URL"].some((label, i) => cellText(labels.getRow(1).getCell(i + 1)) !== label) || labels.columnCount > 2) throw Error("洗唛吊牌图明细表头应依次为：序缇款号、图片URL");
    if (labels.getImages().length) throw Error("请在洗唛吊牌图明细填写图片地址，不支持 Excel 浮动图片");
    const seen = new Set<string>();
    for (let r = 2; r <= labels.rowCount; r++) {
      const style = cellText(labels.getRow(r).getCell(1)), url = cellText(labels.getRow(r).getCell(2));
      if (!style && !url) continue;
      const record = byStyle.get(style); if (!record || !url) throw Error(`洗唛吊牌图明细第 ${r} 行缺少对应款号或图片URL`);
      if (!seen.has(style)) { if (record.labelImages) throw Error(`「${style}」的洗唛/吊牌图请只填写在主表或图片明细其中一处`); record.labelImages = []; seen.add(style); }
      record.labelImages.push(imageValue("", url));
    }
  }
  if (!result.length) throw Error("文件中没有可导入的款式");
  return result;
}
