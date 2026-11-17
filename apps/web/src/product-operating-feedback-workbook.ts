import type ExcelJS from "exceljs";
import {
  clearanceReasonLabels,
  supplyReasonLabels,
  type OperatingDecisionItem,
  type OperatingFeedback,
} from "../../../packages/contracts/src/product-operating-decisions.js";
import { loadExcelJS } from "./exceljs-loader.js";

export const operatingFeedbackWorkbookLimit = 200;
export const operatingFeedbackWorkbookMaxBytes = 5 * 1024 * 1024;

export type OperatingFeedbackWorkbookRow = {
  styleNo: string;
  rowId?: string;
  feedback: Partial<OperatingFeedback>;
  version?: number;
  rowVersion?: number;
  line: number;
};

const sheetName = "经营反馈";
const columns = [
  { key: "styleNo", header: "款号", width: 24 },
  { key: "supply", header: "补货条件", width: 18 },
  { key: "supplyReasons", header: "补货判断原因", width: 36 },
  { key: "supplyNote", header: "采购反馈补充", width: 36 },
  { key: "backlog", header: "压仓库存", width: 14 },
  { key: "clearance", header: "停售反馈", width: 18 },
  { key: "clearanceNote", header: "退供清仓补充", width: 36 },
  { key: "salesConfirmation", header: "人工确认销售状态", width: 22 },
  { key: "confirmationReason", header: "销售状态确认原因", width: 36 },
  { key: "version", header: "反馈版本", width: 14 },
  { key: "rowVersion", header: "档案版本", width: 14 },
  { key: "rowId", header: "档案行ID", width: 22 },
] as const;
type Header = (typeof columns)[number];
type Field = Header["key"];
const headersByText = new Map<string, Header>(
  columns.map((column) => [column.header, column]),
);
const supplyLabels: Record<OperatingFeedback["supply"], string> = {
  pending: "待确认",
  allow: "允许补货",
  deny: "不允许补货",
};
const salesLabels: Record<OperatingFeedback["salesConfirmation"], string> = {
  auto: "采用规则建议",
  keep: "确认继续销售",
  stop: "确认停售",
};

export async function writeOperatingFeedbackWorkbook(
  items: OperatingDecisionItem[],
): Promise<Blob> {
  const { Workbook } = await loadExcelJS();
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = columns.map((column) => ({
    ...column,
    style: { numFmt: "@", alignment: { vertical: "top", wrapText: true } },
  }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF344D72" },
  };
  header.height = 25;
  sheet.getCell("A1").note = "填写商品档案中的完整款号，保留文本格式和前导零。";
  sheet.getCell("B1").note = Object.values(supplyLabels).join("、");
  sheet.getCell("C1").note =
    `可填${Object.values(supplyReasonLabels).join("、")}。多个原因用顿号分隔，原因须与补货条件一致。`;
  const notesHint =
    "填入要更新的说明。不带版本的行留空时保留原说明，带版本的导出行留空时清空原说明。";
  sheet.getCell("D1").note = notesHint;
  sheet.getCell("E1").note = "填「是」或「否」。留空保留现有标记。";
  sheet.getCell("F1").note = Object.values(clearanceReasonLabels).join("、");
  sheet.getCell("G1").note = notesHint;
  sheet.getCell("H1").note = Object.values(salesLabels).join("、");
  sheet.getCell("I1").note = "人工确认继续销售或停售时须填写原因。";
  sheet.getCell("J1").note = "请保留导出时的版本号，以检查反馈是否已发生修改。";
  sheet.getCell("K1").note = "请保留导出时的版本号，以检查档案是否已发生修改。";
  sheet.getCell("L1").note =
    "使用空白模板时可留空。同款号有多条档案时，请导出并保留目标档案行ID。";
  for (const item of items) {
    const feedback = item.feedback;
    // Keep codes and notes as literal strings, including leading zeros and "=".
    sheet.addRow({
      styleNo: item.styleNo,
      supply: supplyLabels[feedback.supply],
      supplyReasons: feedback.supplyReasons
        .map((reason) => supplyReasonLabels[reason])
        .join("、"),
      supplyNote: feedback.supplyNote,
      backlog: feedback.backlog ? "是" : "否",
      clearance: clearanceReasonLabels[feedback.clearance],
      clearanceNote: feedback.clearanceNote,
      salesConfirmation: salesLabels[feedback.salesConfirmation],
      confirmationReason: feedback.confirmationReason,
      version: String(item.version),
      rowVersion: String(item.rowVersion),
      rowId: item.rowId,
    });
  }
  const bytes = await workbook.xlsx.writeBuffer();
  return new Blob([new Uint8Array(bytes)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function cellValue(cell: ExcelJS.Cell, header?: Header): string {
  const raw = cell.value;
  if (raw == null) return "";
  const position = `第 ${cell.row} 行${header ? `「${header.header}」` : "表头"}（${cell.address}）`;
  if (typeof raw === "object") {
    if ("formula" in raw || "sharedFormula" in raw)
      throw Error(`${position}含公式，请先粘贴为值`);
    if ("richText" in raw) return cell.text.trim();
    throw Error(`${position}无法读取，请填入文本或有效数值`);
  }
  if (header?.key === "styleNo" && typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0 || raw >= 1e15)
      throw Error(`${position}的数字款号可能失真，请按原款号填写文本`);
    const format = cell.numFmt;
    return /^0{1,150}$/.test(format)
      ? String(raw).padStart(format.length, "0")
      : String(raw);
  }
  if (header?.key === "styleNo" && typeof raw === "boolean")
    throw Error(`${position}请填写有效款号`);
  if (header?.key === "rowId" && typeof raw === "number" && raw >= 1e15)
    throw Error(`${position}的数字档案行ID可能失真，请保留导出的文本格式`);
  return String(raw).trim();
}

function choice<Key extends string>(
  text: string,
  labels: Record<Key, string>,
  invalid: () => never,
): Key {
  const keys = Object.keys(labels) as Key[];
  return keys.find((key) => labels[key] === text) ?? invalid();
}

export async function readOperatingFeedbackWorkbook(
  file: File,
): Promise<OperatingFeedbackWorkbookRow[]> {
  if (!/\.xlsx$/i.test(file.name))
    throw Error("请选择 .xlsx 格式的 Excel 文件");
  if (file.size > operatingFeedbackWorkbookMaxBytes)
    throw Error("Excel 文件不能超过 5 MB");

  const { Workbook } = await loadExcelJS();
  const workbook = new Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch (cause) {
    throw Error("无法读取 Excel 文件，请另存为 .xlsx 后重试", { cause });
  }
  const sheet = workbook.getWorksheet(sheetName) ?? workbook.worksheets[0];
  if (!sheet) throw Error("Excel 文件中没有工作表");
  const headerRow = sheet.getRow(1);
  if (headerRow.cellCount > 100) throw Error("表头最多支持 100 列");
  const indexes = new Map<Field, { header: Header; index: number }>();
  headerRow.eachCell((cell, index) => {
    const header = headersByText.get(cellValue(cell));
    if (!header) return;
    if (indexes.has(header.key))
      throw Error(`第 1 行表头「${header.header}」重复，请删除重复列`);
    indexes.set(header.key, { header, index });
  });
  if (!indexes.has("styleNo")) throw Error("第 1 行缺少「款号」表头");

  const entries: OperatingFeedbackWorkbookRow[] = [];
  const seenStyles = new Map<string, { line: number; rowId?: string }>();
  const seenIds = new Map<string, number>();
  sheet.eachRow((row, line) => {
    if (line === 1) return;
    const values = new Map<Field, string>(
      Array.from(indexes, ([key, { header, index }]) => [
        key,
        cellValue(row.getCell(index), header),
      ]),
    );
    if (![...values.values()].some(Boolean)) return;
    if (entries.length === operatingFeedbackWorkbookLimit)
      throw Error(
        `第 ${line} 行超出每批 ${operatingFeedbackWorkbookLimit} 款的上限`,
      );

    const invalid = (key: Field, reason: string): never => {
      const column = indexes.get(key)!;
      throw Error(
        `第 ${line} 行「${column.header.header}」（${row.getCell(column.index).address}）${reason}`,
      );
    };
    const styleNo = values.get("styleNo") ?? "";
    if (!styleNo || styleNo.length > 150)
      invalid("styleNo", "须填写 1–150 个字符");
    const rowId = values.get("rowId") || undefined;
    if (rowId) {
      if (
        !/^[1-9]\d{0,18}$/.test(rowId) ||
        BigInt(rowId) > 9223372036854775807n
      )
        invalid("rowId", "请填写导出文件中的有效档案行ID");
      const priorId = seenIds.get(rowId);
      if (priorId !== undefined)
        invalid("rowId", `与第 ${priorId} 行档案行ID重复`);
      seenIds.set(rowId, line);
    }
    const styleKey = styleNo.toUpperCase();
    const priorStyle = seenStyles.get(styleKey);
    if (priorStyle && (!priorStyle.rowId || !rowId))
      invalid(
        "styleNo",
        `与第 ${priorStyle.line} 行款号重复，请使用导出的档案行ID区分`,
      );
    seenStyles.set(styleKey, { line, rowId });

    const feedback: Partial<OperatingFeedback> = {};
    const supply = values.get("supply");
    if (supply)
      feedback.supply = choice(supply, supplyLabels, () =>
        invalid("supply", "请填写待确认、允许补货或不允许补货"),
      );
    const reasons = values.get("supplyReasons");
    if (reasons) {
      const provided = reasons
        .split(/[、,，;；/\r\n]+/)
        .map((part) => part.trim())
        .filter(Boolean);
      if (!provided.length)
        invalid("supplyReasons", "请填写有效的补货判断原因");
      feedback.supplyReasons = [
        ...new Set(
          provided.map((reason) =>
            choice(reason, supplyReasonLabels, () =>
              invalid(
                "supplyReasons",
                `包含未知原因「${reason.slice(0, 80)}」`,
              ),
            ),
          ),
        ),
      ];
    }
    const backlog = values.get("backlog")?.toLowerCase();
    if (backlog) {
      if (["是", "true", "1"].includes(backlog)) feedback.backlog = true;
      else if (["否", "false", "0"].includes(backlog)) feedback.backlog = false;
      else invalid("backlog", "请填写是或否");
    }
    const clearance = values.get("clearance");
    if (clearance)
      feedback.clearance = choice(clearance, clearanceReasonLabels, () =>
        invalid("clearance", "请填写无停售反馈、品质退供、大货退供或清仓完结"),
      );
    const sales = values.get("salesConfirmation");
    if (sales)
      feedback.salesConfirmation = choice(sales, salesLabels, () =>
        invalid(
          "salesConfirmation",
          "请填写采用规则建议、确认继续销售或确认停售",
        ),
      );

    const entry: OperatingFeedbackWorkbookRow = {
      styleNo,
      ...(rowId ? { rowId } : {}),
      feedback,
      line,
    };
    for (const key of ["version", "rowVersion"] as const) {
      const value = values.get(key);
      if (!value) continue;
      const version = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(version))
        invalid(key, "请填写有效的非负整数版本号");
      entry[key] = version;
    }
    const hasVersion =
      entry.version !== undefined || entry.rowVersion !== undefined;
    for (const key of [
      "supplyNote",
      "clearanceNote",
      "confirmationReason",
    ] as const) {
      const value = values.get(key);
      if (
        value === undefined ||
        (!value && (key === "confirmationReason" || !hasVersion))
      )
        continue;
      if (value.length > 1000) invalid(key, "不能超过 1000 个字符");
      feedback[key] = value;
    }
    entries.push(entry);
  });
  if (!entries.length) throw Error("Excel 中没有可导入的反馈行");
  return entries;
}
