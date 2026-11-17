import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  emptyOperatingFeedback,
  evaluateOperatingDecision,
  type OperatingDecisionItem,
} from "../../packages/contracts/src/product-operating-decisions.js";
import {
  operatingFeedbackWorkbookLimit,
  readOperatingFeedbackWorkbook,
  writeOperatingFeedbackWorkbook,
} from "../../apps/web/src/product-operating-feedback-workbook.js";

async function workbookFile(
  rows: ExcelJS.CellValue[][],
  setup?: (sheet: ExcelJS.Worksheet) => void,
) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("经营反馈");
  sheet.addRows(rows);
  setup?.(sheet);
  return new File(
    [new Uint8Array(await book.xlsx.writeBuffer())],
    "经营反馈.xlsx",
  );
}

describe("经营决策反馈工作簿", () => {
  it("保留完整反馈、版本和款号前导零，像公式的说明作为文本往返", async () => {
    const feedback = {
      ...emptyOperatingFeedback(),
      supply: "allow",
      supplyReasons: ["stock", "fast"],
      supplyNote: "=1+2",
      clearanceNote: "准备清仓\n先销售已有库存",
      backlog: true,
      salesConfirmation: "keep",
      confirmationReason: "销完为止",
    } satisfies OperatingDecisionItem["feedback"];
    const blob = await writeOperatingFeedbackWorkbook([
      {
        rowId: "9223372036854775807",
        rowVersion: 7,
        styleNo: "0000123",
        version: 0,
        canEdit: true,
        feedback,
        decision: evaluateOperatingDecision(feedback, [], null, "2026-11-17"),
        updatedAt: null,
        updatedBy: null,
        needsReconfirmation: false,
      },
    ]);
    const file = new File([blob], "经营反馈.xlsx");
    expect(await readOperatingFeedbackWorkbook(file)).toEqual([
      {
        styleNo: "0000123",
        rowId: "9223372036854775807",
        feedback,
        version: 0,
        rowVersion: 7,
        line: 2,
      },
    ]);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await file.arrayBuffer());
    expect(book.worksheets[0].getCell("D2").value).toBe("=1+2");
    expect(book.worksheets[0].getCell("L2").value).toBe("9223372036854775807");
  });

  it("空白反馈模板包含表头与说明，填写时空白备注默认不改动", async () => {
    const template = await writeOperatingFeedbackWorkbook([]);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await template.arrayBuffer());
    const sheet = book.getWorksheet("经营反馈")!;
    expect(sheet.actualRowCount).toBe(1);
    expect((sheet.getRow(1).values as string[]).slice(1)).toEqual([
      "款号",
      "补货条件",
      "补货判断原因",
      "采购反馈补充",
      "压仓库存",
      "停售反馈",
      "退供清仓补充",
      "人工确认销售状态",
      "销售状态确认原因",
      "反馈版本",
      "档案版本",
      "档案行ID",
    ]);
    expect(sheet.getCell("C1").note).toBeTruthy();
    expect(sheet.getCell("I1").note).toBeTruthy();
    sheet.addRow(["0000123", "", "", "", "是"]);
    const file = new File(
      [new Uint8Array(await book.xlsx.writeBuffer())],
      "反馈模板.xlsx",
    );
    expect(await readOperatingFeedbackWorkbook(file)).toEqual([
      { styleNo: "0000123", feedback: { backlog: true }, line: 2 },
    ]);
  });

  it("支持部分列、稀疏行、零填充数值款号和多种原因分隔符", async () => {
    const file = await workbookFile(
      [
        [
          "补货判断原因",
          "款号",
          "补货条件",
          "采购反馈补充",
          "销售状态确认原因",
          "压仓库存",
        ],
        [],
        [
          "供应商有现货；生产周期不超过20天\n供应商有现货",
          12,
          "",
          "",
          "",
          false,
        ],
      ],
      (sheet) => {
        sheet.getCell("B3").numFmt = "00000";
      },
    );
    expect(await readOperatingFeedbackWorkbook(file)).toEqual([
      {
        styleNo: "00012",
        feedback: {
          supplyReasons: ["stock", "fast"],
          backlog: false,
        },
        line: 3,
      },
    ]);
  });

  it("导出的版本允许清空备注，档案行ID单独使用时仍保留空白备注", async () => {
    const file = await workbookFile([
      [
        "款号",
        "采购反馈补充",
        "退供清仓补充",
        "销售状态确认原因",
        "档案行ID",
        "反馈版本",
      ],
      ["S-1", "", "", "", 21, 0],
      ["S-2", "", "退供原因", "", "22"],
    ]);
    expect(await readOperatingFeedbackWorkbook(file)).toEqual([
      {
        styleNo: "S-1",
        rowId: "21",
        version: 0,
        feedback: { supplyNote: "", clearanceNote: "" },
        line: 2,
      },
      {
        styleNo: "S-2",
        rowId: "22",
        feedback: { clearanceNote: "退供原因" },
        line: 3,
      },
    ]);
  });

  it("定位重复款号、公式、未知选择和值格式问题", async () => {
    const duplicate = await workbookFile([["款号"], [" abc "], [], ["ABC"]]);
    await expect(readOperatingFeedbackWorkbook(duplicate)).rejects.toThrow(
      "第 4 行「款号」（A4）与第 2 行款号重复",
    );

    const formula = await workbookFile([
      ["款号", "采购反馈补充"],
      ["S-1", { formula: "1+2", result: 3 }],
    ]);
    await expect(readOperatingFeedbackWorkbook(formula)).rejects.toThrow(
      "第 2 行「采购反馈补充」（B2）含公式",
    );

    const invalidChoice = await workbookFile([
      ["款号", "补货判断原因"],
      ["S-1", "不确定"],
    ]);
    await expect(readOperatingFeedbackWorkbook(invalidChoice)).rejects.toThrow(
      "包含未知原因「不确定」",
    );

    const missingId = await workbookFile([
      ["款号", "压仓库存"],
      ["", "是"],
    ]);
    await expect(readOperatingFeedbackWorkbook(missingId)).rejects.toThrow(
      "第 2 行「款号」（A2）",
    );

    const malformedId = await workbookFile([["款号"], [1234567890123456]]);
    await expect(readOperatingFeedbackWorkbook(malformedId)).rejects.toThrow(
      "数字款号可能失真",
    );
  });

  it("允许使用各自档案行ID区分同款号，拒绝重复ID和无ID的同款混合导入", async () => {
    const file = await workbookFile([
      ["款号", "档案行ID"],
      [" S-1 ", "12"],
      ["s-1", "13"],
    ]);
    expect(await readOperatingFeedbackWorkbook(file)).toEqual([
      { styleNo: "S-1", rowId: "12", feedback: {}, line: 2 },
      { styleNo: "s-1", rowId: "13", feedback: {}, line: 3 },
    ]);
    await expect(
      readOperatingFeedbackWorkbook(
        await workbookFile([
          ["款号", "档案行ID"],
          ["S-1", "12"],
          ["S-2", "12"],
        ]),
      ),
    ).rejects.toThrow("与第 2 行档案行ID重复");
    await expect(
      readOperatingFeedbackWorkbook(
        await workbookFile([
          ["款号", "档案行ID"],
          ["S-1", "12"],
          ["s-1", ""],
        ]),
      ),
    ).rejects.toThrow("使用导出的档案行ID区分");
    await expect(
      readOperatingFeedbackWorkbook(
        await workbookFile([
          ["款号", "档案行ID"],
          ["S-1", "9223372036854775808"],
        ]),
      ),
    ).rejects.toThrow("请填写导出文件中的有效档案行ID");
    await expect(
      readOperatingFeedbackWorkbook(
        await workbookFile([
          ["款号", "档案行ID"],
          ["S-1", 1234567890123456],
        ]),
      ),
    ).rejects.toThrow("数字档案行ID可能失真");
  });

  it("导出可以超过导入上限，并保留同款号的多条档案行", async () => {
    const feedback = emptyOperatingFeedback();
    const decision = evaluateOperatingDecision(
      feedback,
      [],
      null,
      "2026-11-17",
    );
    const items: OperatingDecisionItem[] = Array.from(
      { length: operatingFeedbackWorkbookLimit + 1 },
      (_, i) => ({
        rowId: String(i + 1),
        rowVersion: 0,
        styleNo: "S-1",
        version: 0,
        canEdit: true,
        feedback,
        decision,
        updatedAt: null,
        updatedBy: null,
        needsReconfirmation: false,
      }),
    );
    const exported = await writeOperatingFeedbackWorkbook(items);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exported.arrayBuffer());
    const sheet = workbook.getWorksheet("经营反馈")!;
    expect(sheet.actualRowCount).toBe(operatingFeedbackWorkbookLimit + 2);
    expect([sheet.getCell("A2").value, sheet.getCell("L2").value]).toEqual([
      "S-1",
      "1",
    ]);
    expect([sheet.getCell("A3").value, sheet.getCell("L3").value]).toEqual([
      "S-1",
      "2",
    ]);
  });

  it("限制单批记录数并拒绝重名的输入列", async () => {
    const rows = Array.from(
      { length: operatingFeedbackWorkbookLimit + 1 },
      (_, index) => [`SKU-${index + 1}`],
    );
    const overflow = await workbookFile([["款号"], ...rows]);
    await expect(readOperatingFeedbackWorkbook(overflow)).rejects.toThrow(
      "第 202 行超出每批 200 款的上限",
    );
    const repeatedHeader = await workbookFile([
      ["款号", "款号"],
      ["S-1", "S-2"],
    ]);
    await expect(readOperatingFeedbackWorkbook(repeatedHeader)).rejects.toThrow(
      "表头「款号」重复",
    );
  });
});
