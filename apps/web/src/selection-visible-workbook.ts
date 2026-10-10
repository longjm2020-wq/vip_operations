import type ExcelJS from "exceljs";
import type { SelectionField, SelectionLayout } from "../../../packages/contracts/src/selection-layout.js";
import { selectionRowHasContent } from "../../../packages/contracts/src/selection-trailing-row.js";
import { fieldImages, orderedFieldTags, systemField } from "./selection-field-types.js";
import { selectionSystemValue } from "./selection-system-fields.js";
import { choiceDisplayText } from "./selection-choice-display.js";

type Row = Record<string, any>;
type Options = { archiveReferences?: Record<string, Row[]> };
const custom = (field: SelectionField) => !!field.custom || field.key.startsWith("custom:");
const imageField = (field: SelectionField) => ["images", "labelImages"].includes(field.key) || (field.type || field.fallbackType) === "image";
const denied = (row: Row, field: SelectionField) => row.hiddenCells?.includes(field.key) || row.cellAccess?.[field.key] === "deny" ||
  (row.cellAccess && custom(field) && !Object.hasOwn(row.cellAccess, field.key)) ||
  (row.cellAccess && !Object.hasOwn(row.cellAccess, field.key) && row.defaultCellAccess === "deny");

/** Recheck saved definitions, including field revocation, before deriving system values. */
export function visibleSelectionWorkbookFields(columns: SelectionField[], preferences: SelectionLayout | null): SelectionField[] {
  const latest = new Map(preferences?.columns.map(field => [field.key, field]));
  const hidden = new Set(preferences?.hiddenColumns || []);
  return columns.flatMap(field => {
    const current = preferences ? latest.get(field.key) : custom(field) ? undefined : field;
    return current && !current.deleted && !hidden.has(current.key) ? [current] : [];
  });
}

/** Work on raw permission-projected records; derived system values never populate a draft. */
export function prepareVisibleSelectionWorkbookRecords(records: Row[], columns: SelectionField[]): Row[] {
  return records.filter(row => selectionRowHasContent(row) || columns.some(field => denied(row, field)));
}

function valueAt(row: Row, field: SelectionField, options: Options): string {
  if (systemField(field)) return selectionSystemValue(row, field);
  if (field.key === "collectionInventory") return String((row.collectionInventory || []).reduce((total: number, item: Row) => total + Number(item.available || 0) + Number(item.production || 0), 0));
  const value = custom(field) ? row.extraFields?.[field.key] : row[field.key];
  const reference = field.key.startsWith("custom:product:") ? field.key.slice("custom:product:".length) : "";
  if (reference === "status") return ({ ACTIVE: "在用", STOPPED: "停用", ARCHIVED: "归档" } as Record<string, string>)[String(value)] || String(value ?? "");
  if (reference && options.archiveReferences?.[reference])
    return options.archiveReferences[reference].find(item => String(item.id) === String(value))?.name || String(value ?? "");
  if ((field.type || field.fallbackType) === "checkbox") return value == null || value === "" ? "" : value === true || value === "true" ? "是" : "否";
  if ((field.type || field.fallbackType) === "multiple") return choiceDisplayText(field, value);
  if ((field.type || field.fallbackType) === "tags") return orderedFieldTags(field, value).join("/");
  if (field.key === "registrationBatch") return String(value ?? "").slice(0, 10);
  return String(value ?? "");
}

function styleSheet(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF805239" } };
  sheet.getRow(1).height = 26;
  sheet.eachRow(row => { row.alignment = { vertical: "top", wrapText: true }; });
}

export async function createVisibleSelectionWorkbook(records: Row[], columns: SelectionField[], options: Options = {}) {
  const fields = columns.filter(field => !field.deleted);
  if (!fields.length) throw Error("没有可导出的可见字段");
  const populated = prepareVisibleSelectionWorkbookRecords(records, fields);
  if (!populated.length) throw Error("没有可导出的资料");
  const { Workbook } = (await import("exceljs")).default;
  const book = new Workbook();
  const sheet = book.addWorksheet("表格资料");
  sheet.columns = fields.map(field => ({ header: field.label, width: Math.min(60, Math.max(12, field.width / 7)), style: { numFmt: "@" } }));
  let pictures: ExcelJS.Worksheet | undefined, imageData: ExcelJS.Worksheet | undefined;
  let imageNumber = 0;
  for (const record of populated) {
    const rowNumber = sheet.rowCount + 1;
    const values = fields.map((field, index) => {
      if (denied(record, field)) return "••••";
      if (!imageField(field)) return valueAt(record, field, options);
      const images = custom(field) ? fieldImages(record.extraFields?.[field.key]) : Array.isArray(record[field.key]) ? record[field.key] : [];
      for (const image of images) {
        if (!pictures) {
          pictures = book.addWorksheet("图片明细");
          pictures.columns = ["资料行", "字段位置", "字段", "颜色", "图片URL"].map(header => ({ header, width: header === "图片URL" ? 70 : 20, style: { numFmt: "@" } }));
        }
        let url = String(image.url || "");
        if (url.startsWith("data:image/")) {
          imageData ||= book.addWorksheet("图片内容", { state: "hidden" });
          const reference = `内嵌图片:${++imageNumber}`;
          for (let offset = 0; offset < url.length; offset += 30000) imageData.addRow([reference, offset / 30000, url.slice(offset, offset + 30000)]);
          url = reference;
        }
        pictures.addRow([String(rowNumber), String(index + 1), field.label, String(image.color || ""), url]);
      }
      return images.length ? "见图片明细" : "";
    });
    sheet.addRow(values);
  }
  styleSheet(sheet);
  if (pictures) styleSheet(pictures);
  const notes = book.addWorksheet("导出说明");
  notes.getColumn(1).width = 110;
  notes.addRows([
    ["本文件为当前表格显示字段的资料快照，按表头名称和顺序逐行导出。横向滚动之外的显示列也包含在内。"],
    ["未显示、已删除或无字段查看权限的列不导出；禁止查看的单元格仅输出 ••••，不包含真实内容或图片。"],
    ["可识别的空白草稿自动忽略；系统生成信息和格式不单独计为填写内容。无法确认是否为空的受保护记录保留遮罩，缺款号和同款号多行仍逐行保留。"],
    ["数字和标识保留文本原值；系统字段按人员、北京时间和编号显示设置生成，商品关联字段显示名称，无法读取名称时保留原标识。"],
    ["图片明细按表格资料的 Excel 行号、字段位置和字段名称对应。系统图片地址须登录并具有当前图片查看权限。"],
    ["旧版内嵌图片分段保存在隐藏的图片内容工作表中；仅保存本次可见且获准查看的图片，不嵌入浮动图片。"],
    ["本文件不包含表格填色、对齐等样式，不能直接作为标准导入文件；导入请从「导入 → 下载模板」填写固定格式。"],
  ]);
  return book;
}

export async function downloadVisibleSelectionWorkbook(records: Row[], columns: SelectionField[], title = "选款登记", options: Options = {}) {
  const book = await createVisibleSelectionWorkbook(records, columns, options);
  const buffer = await book.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buffer as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")}可见字段资料.xlsx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
