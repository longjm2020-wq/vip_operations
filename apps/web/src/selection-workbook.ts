import type ExcelJS from "exceljs";
import { selectionRowHasContent } from "../../../packages/contracts/src/selection-trailing-row.js";
import { selectionImportHeader, selectionImportLimits, selectionImportTemplateFields } from "../../../packages/contracts/src/selection-import-template.js";
import { registerSelectionImportSource, type SelectionImportWorkbookSource } from "./selection-import-diagnostics.js";

type Row = Record<string, any>;
export const selectionSheetColumns = [
  ["registrationBatch", "登记批次"], ["images", "图片"], ["labelImages", "洗唛/吊牌图"], ["xutiStyleNo", "序缇款号"],
  ["supplierStyleNo", "供应商款号"], ["supplierCode", "供应商编码"], ["color", "颜色"],
  ["sizeRange", "尺码范围"], ["material", "材质"], ["supplyPriceExclTax", "供货价（不含税）"],
  ["vipPrice", "唯品价"], ["livePrice", "直播价"], ["tagPrice", "吊牌价"],
] as const;
const priceKeys = new Set(["supplyPriceExclTax", "vipPrice", "livePrice", "tagPrice"]);
export function prepareSelectionWorkbookRecords(records: Row[]): Row[] {
  const populated = records.map((record, index) => ({ record, index })).filter(({ record }) => selectionRowHasContent(record));
  const missing = populated.filter(({ record }) => !String(record.xutiStyleNo ?? "").trim());
  if (missing.length) {
    const examples = missing.slice(0, 5).map(({ record, index }) => {
      const details = [["供应商款号", record.supplierStyleNo], ["供应商编码", record.supplierCode]]
        .filter(([, value]) => String(value ?? "").trim())
        .map(([label, value]) => `${label}：${String(value).trim()}`).join("；");
      return `第 ${index + 1} 条${details ? `（${details}）` : ""}`;
    }).join("、");
    throw Error(`导出范围内有 ${missing.length} 条已填写内容的记录缺少序缇款号：${examples}${missing.length > 5 ? "等" : ""}。请补齐后导出，空白行会自动忽略`);
  }
  return populated.map(({ record }) => record);
}
function styleSheet(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF805239" } };
  sheet.getRow(1).height = 26;
  sheet.eachRow(row => { row.alignment = { vertical: "top", wrapText: true }; });
}
export async function createSelectionWorkbook(records: Row[] = [], template = false) {
  const { Workbook } = (await import("exceljs")).default;
  const book = new Workbook();
  const sheet = book.addWorksheet("选款资料");
  const columns = template
    ? selectionImportTemplateFields.map(field => ({ key: field.builtinKey || `field:${field.label}`, header: field.label }))
    : selectionSheetColumns.map(([key, header]) => ({ key, header }));
  sheet.columns = columns.map(({ key, header }) => ({ key, header, width: key === "material" ? 32 : 20, style: { numFmt: "@" } }));
  if (template) {
    sheet.getCell("A1").note = "系统只读字段。新款由服务器记录创建时间，填写此列不会修改已有款创建时间。";
    sheet.getCell("C1").note = "必填。按序缇款号匹配已有款；可仅保留序缇款号及需要更新的字段列。";
  }
  const pictures = book.addWorksheet("图片明细");
  const standardPictures = template;
  pictures.columns = [{ key: "style", header: "序缇款号", width: 24 }, { key: "color", header: standardPictures ? "标准颜色" : "颜色", width: 18 }, { key: "url", header: "图片URL", width: 70 }].map(c => ({ ...c, style: { numFmt: "@" } }));
  const labels = book.addWorksheet("洗唛吊牌图明细");
  labels.columns = [{ key: "style", header: "序缇款号", width: 24 }, { key: "url", header: "图片URL", width: 70 }].map(c => ({ ...c, style: { numFmt: "@" } }));
  let dataSheet: ExcelJS.Worksheet | undefined;
  let imageNumber = 0;
  const codes = new Set<string>();
  for (const record of prepareSelectionWorkbookRecords(records)) {
    const style = String(record.xutiStyleNo ?? "").trim();
    if (codes.has(style)) throw Error(`序缇款号「${style}」存在多条记录，请勾选唯一款式后导出`);
    codes.add(style);
    const values = Object.fromEntries(columns.map(({ key, header }) => [key, key === "images" ? (record.images?.length ? "见图片明细" : "") : key === "labelImages" ? (record.labelImages?.length ? "见洗唛吊牌图明细" : "") : key === "registrationBatch" ? (template ? "" : String(record[key] || "").slice(0, 10)) : String(key.startsWith("field:") ? record.fieldValues?.[header] ?? "" : record[key] ?? "")]));
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
    ["已有款由用户选择覆盖更新或跳过不覆盖，新款新增。覆盖仅更新文件中已填写的字段；空白和未提供的字段保留原值，不用于清空。"],
    ["创建时间为系统只读字段，由服务器自动记录；填写此列不会修改创建时间。旧模板中的登记批次仍可兼容导入，但不改变创建时间。"],
    ["可仅保留「序缇款号」加任意一列或多列进行针对性更新。序缇款号必填，文件内同款重复会阻止导入。"],
    [`可添加自定义表头（1至40个字符，文件最多${selectionImportLimits.maxColumns}列），新自定义字段默认排在模板默认字段之后；已有同名可见字段按其设置校验，重名或无权限请先核对。`],
    ["供应商颜色、尺码用 / 分隔；金额为非负数字，整数最多10位、最多两位小数，数值0会正常导入。数值型金额的极小存储误差会纠正（例如228.00000000000003按228处理）；超过两位小数的金额仍需修正。金额错误显示行号、单元格位置和原值。"],
    ["新模板「图片明细」表头依次为序缇款号、标准颜色、图片URL；图片按该款标准颜色匹配，多个标准颜色用 / 分隔，已有款未填写标准颜色时沿用系统值，不使用供应商颜色替代。旧文件的「颜色」表头仍按供应商颜色匹配。"],
    ["图片颜色不匹配时，导入提示指出款号、具体颜色及图片所在工作表/行号/单元格；系统原图冲突会注明系统已有图片，修正后重新上传。"],
    ["也可在主表图片列逐行填写「颜色 | https://图片地址」；不填颜色时可仅填网址。"],
    ["图片明细与主表图片不能同时填写同款；填写图片将替换该款原图片，留空则保留。"],
    ["洗唛/吊牌图可在「洗唛吊牌图明细」逐图填写款号和图片URL；填写后替换该款原洗唛/吊牌图，留空保留。"],
    ["系统内图片地址须登录同一系统查看。旧版内嵌图片自动保存在隐藏工作表中，请保留该表。"],
    ["仅支持本模板的数据与图片地址，不解析 Excel 浮动图片。公式请先粘贴为值。"],
    [`每次导入最多 ${selectionImportLimits.maxRows} 款、文件 ${selectionImportLimits.maxFileBytes / 1024 / 1024} MB；空白行和仅有格式的空白行不计入款数。导入预览确认后整批写入，冲突则整批不写入。`],
    ["单元格填色和列布局不从文件导入，更新时保留系统现有设置；仅填写创建时间却未填款号也会提示缺少序缇款号，完全空白行会自动忽略。"],
  ]);
  return book;
}
export async function downloadSelectionWorkbook(records: Row[] = [], template = false) {
  const book = await createSelectionWorkbook(records, template);
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
const pricePrecision = new DataView(new ArrayBuffer(8));
function priceText(cell: ExcelJS.Cell, row: number, label: string, text: string): string {
  const invalid = (): never => {
    const raw = typeof cell.value === "number" ? String(cell.value) : cell.text;
    throw Error(`第 ${row} 行${label}应为非负金额，最多两位小数（单元格 ${cell.address}，原值 ${JSON.stringify(raw.slice(0, 80))}${raw.length > 80 ? "…" : ""}）`);
  };
  const value = cell.value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 9999999999.99) invalid();
    const cents = Math.round(value * 100) / 100;
    // Read the IEEE-754 exponent directly: Math.log2 can round up just below a power of two.
    pricePrecision.setFloat64(0, value);
    const exponent = (pricePrecision.getUint32(0) >>> 20) & 0x7ff;
    const ulp = exponent ? 2 ** (exponent - 1023 - 52) : Number.MIN_VALUE;
    if ((value !== 0 && cents === 0) || Math.abs(value - cents) > ulp) invalid();
    // Number formats such as 0000 affect display, not the imported amount.
    text = String(cents);
  } else {
    text = text.replace(/[￥¥,，\s]/g, "");
  }
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) invalid();
  return text;
}
export async function parseSelectionWorkbook(buffer: ArrayBuffer) {
  if (buffer.byteLength > selectionImportLimits.maxFileBytes) throw Error(`文件不能超过 ${selectionImportLimits.maxFileBytes / 1024 / 1024} MB`);
  const { Workbook } = (await import("exceljs")).default;
  const book = new Workbook(); await book.xlsx.load(buffer);
  const sheet = book.getWorksheet("选款资料");
  if (!sheet) throw Error("缺少「选款资料」工作表，请使用下载的模板");
  if (sheet.columnCount > selectionImportLimits.maxColumns) throw Error(`每次导入最多 ${selectionImportLimits.maxColumns} 列，请减少字段并清除多余格式`);
  if (sheet.getImages().length) throw Error("请在图片明细填写图片地址，不支持 Excel 浮动图片");
  const headers = new Map<string, { index: number; label: string; sourceLabel: string; key?: string; readonly?: true }>();
  for (let index = 1; index <= sheet.columnCount; index++) {
    const name = cellText(sheet.getRow(1).getCell(index));
    if (!name) {
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
          const cell = row.getCell(index);
          if (cell.value != null && cellText(cell)) throw Error(`第 ${index} 列缺少表头`);
        }
      });
      continue;
    }
    if (name.length > 40) throw Error(`表头「${name}」最多40个字符`);
    const definition = selectionImportHeader(name), identity = definition?.builtinKey ? `builtin:${definition.builtinKey}` : `label:${definition?.label || name}`;
    if (headers.has(identity)) throw Error(`表头「${name}」重复或与「${headers.get(identity)!.label}」表示同一字段`);
    headers.set(identity, { index, label: definition?.label || name, sourceLabel: name, key: definition?.builtinKey, readonly: definition?.readonly });
  }
  if (!headers.has("builtin:xutiStyleNo")) throw Error("缺少序缇款号列");
  const result: Row[] = [];
  const byStyle = new Map<string, Row>();
  const workbookSources = new WeakMap<Row, SelectionImportWorkbookSource>();
  const data = new Map<string, Map<number, string>>();
  book.getWorksheet("图片内容")?.eachRow(row => {
    const key = cellText(row.getCell(1)), offset = Number(cellText(row.getCell(2))), chunk = cellText(row.getCell(3));
    if (!Number.isInteger(offset) || offset < 0 || offset > 50) throw Error("内嵌图片内容损坏");
    const chunks = data.get(key) || new Map<number, string>();
    if (chunks.has(offset)) throw Error("内嵌图片内容重复");
    chunks.set(offset, chunk); data.set(key, chunks);
  });
  const imageValue = (color: string, url: string, standardColor = false) => {
    if (url.startsWith("内嵌图片:")) {
      const chunks = data.get(url); if (!chunks || [...chunks.keys()].some((_, i) => !chunks.has(i))) throw Error("内嵌图片内容缺失");
      url = [...chunks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join("");
    }
    if (!/^https?:\/\//i.test(url) && !/^\/api\/v1\/style-selections\/images\/[0-9a-f-]{36}(?:\?tableId=[1-9]\d*)?$/i.test(url) && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) throw Error("图片URL须为 http(s) 网址或本系统导出的图片地址");
    if (url.length > 1500000) throw Error("单张内嵌图片过大");
    return { id: crypto.randomUUID(), color: color.trim(), url, ...(standardColor ? { colorFieldKey: "standard" } : {}) };
  };
  // Sparse iteration skips format-only rows without allocating every row up to an inflated XLSX dimension.
  sheet.eachRow((row, r) => {
    if (r === 1) return;
    const record: Row = {};
    const colorHeader = headers.get("builtin:color");
    const standardColorHeader = headers.get("label:标准颜色");
    const source: SelectionImportWorkbookSource = { xutiStyleNo: "", row: r, images: [],
      ...(colorHeader ? { colorCell: { cell: row.getCell(colorHeader.index).address, label: colorHeader.sourceLabel } } : {}),
      ...(standardColorHeader ? { standardColorCell: { cell: row.getCell(standardColorHeader.index).address, label: standardColorHeader.sourceLabel } } : {}) };
    const fieldValues: [string, string][] = [];
    let hasFilledCell = false;
    for (const { index, label, key, readonly } of headers.values()) {
      let text = cellText(row.getCell(index));
      if (!text) continue;
      hasFilledCell = true;
      if (readonly || (key === "images" && text === "见图片明细") || (key === "labelImages" && text === "见洗唛吊牌图明细")) continue;
      if (!key) { fieldValues.push([label, text]); continue; }
      if (priceKeys.has(key)) text = priceText(row.getCell(index), r, label, text);
      if (key === "registrationBatch" && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text)) throw Error(`第 ${r} 行日期应为有效的 YYYY-MM-DD`);
      if (key === "color" || key === "sizeRange") text = [...new Set(text.split("/").map(v => v.trim()).filter(Boolean))].join("/");
      const leadingImageLines = key === "images" ? (row.getCell(index).text.match(/^\s*/)?.[0].match(/\n/g)?.length || 0) : 0;
      record[key] = key === "images" ? text.split(/\r?\n/).map((line, index) => ({ line, index })).filter(({ line }) => !!line).map(({ line, index: lineIndex }) => {
        const i = line.indexOf(" | ");
        const image = imageValue(i < 0 ? "" : line.slice(0, i), i < 0 ? line.trim() : line.slice(i + 3).trim());
        source.images.push({ sheet: "选款资料", row: r, cell: row.getCell(index).address, line: lineIndex + leadingImageLines + 1 });
        return image;
      }) : key === "labelImages" ? text.split(/\r?\n/).filter(Boolean).map(line => imageValue("", line.trim())) : text;
    }
    if (!hasFilledCell) return;
    if (fieldValues.length) record.fieldValues = Object.fromEntries(fieldValues);
    if (!record.xutiStyleNo) throw Error(`第 ${r} 行缺少序缇款号`);
    if (byStyle.has(record.xutiStyleNo)) throw Error(`序缇款号「${record.xutiStyleNo}」在文件中重复`);
    if (result.length >= selectionImportLimits.maxRows) throw Error(`每次导入最多 ${selectionImportLimits.maxRows} 款，请拆分文件；空白行不计入款数`);
    source.xutiStyleNo = record.xutiStyleNo;
    registerSelectionImportSource(record, source);
    workbookSources.set(record, source);
    result.push(record); byStyle.set(record.xutiStyleNo, record);
  });
  if (!result.length) throw Error("「选款资料」中没有可导入的款式，请先在主表填写序缇款号；图片明细不能单独导入");
  const imageDetailRecord = (name: string, row: number, style: string, url: string) => {
    if (!style) throw Error(`${name}第 ${row} 行缺少序缇款号，请填写与「选款资料」一致的款号`);
    if (!url) throw Error(`${name}第 ${row} 行缺少图片URL，请填写图片地址`);
    const record = byStyle.get(style);
    if (!record) throw Error(`${name}第 ${row} 行在「选款资料」中找不到对应款号「${style}」，请先在主表填写该款的序缇款号`);
    return record;
  };
  const pictures = book.getWorksheet("图片明细");
  if (pictures) {
    const colorHeader = cellText(pictures.getRow(1).getCell(2));
    if (cellText(pictures.getRow(1).getCell(1)) !== "序缇款号" || !["标准颜色", "颜色", "供应商颜色"].includes(colorHeader) || cellText(pictures.getRow(1).getCell(3)) !== "图片URL" || pictures.columnCount > 3) throw Error("图片明细表头应依次为：序缇款号、标准颜色、图片URL（旧文件的颜色或供应商颜色表头仍兼容）");
    if (pictures.getImages().length) throw Error("请在图片明细填写图片地址，不支持 Excel 浮动图片");
    const seen = new Set<string>();
    pictures.eachRow((row, r) => {
      if (r === 1) return;
      const style = cellText(row.getCell(1)), color = cellText(row.getCell(2)), url = cellText(row.getCell(3));
      if (!style && !color && !url) return;
      const record = imageDetailRecord("图片明细", r, style, url);
      if (!seen.has(style)) { if (record.images) throw Error(`「${style}」的图片请只填写在主表或图片明细其中一处`); record.images = []; seen.add(style); }
      record.images.push(imageValue(color, url, colorHeader === "标准颜色"));
      // The registration stays on the same record used for retries; detail
      // coordinates remain valid after embedded image URLs are uploaded.
      const source = workbookSources.get(record)!;
      source.images.push({ sheet: "图片明细", row: r, cell: row.getCell(2).address });
    });
  }
  const labels = book.getWorksheet("洗唛吊牌图明细");
  if (labels) {
    if (["序缇款号", "图片URL"].some((label, i) => cellText(labels.getRow(1).getCell(i + 1)) !== label) || labels.columnCount > 2) throw Error("洗唛吊牌图明细表头应依次为：序缇款号、图片URL");
    if (labels.getImages().length) throw Error("请在洗唛吊牌图明细填写图片地址，不支持 Excel 浮动图片");
    const seen = new Set<string>();
    labels.eachRow((row, r) => {
      if (r === 1) return;
      const style = cellText(row.getCell(1)), url = cellText(row.getCell(2));
      if (!style && !url) return;
      const record = imageDetailRecord("洗唛吊牌图明细", r, style, url);
      if (!seen.has(style)) { if (record.labelImages) throw Error(`「${style}」的洗唛/吊牌图请只填写在主表或图片明细其中一处`); record.labelImages = []; seen.add(style); }
      record.labelImages.push(imageValue("", url));
    });
  }
  return result;
}
