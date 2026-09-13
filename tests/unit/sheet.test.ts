import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
const { Workbook } = ExcelJS;
import {
  applyMatrix,
  parseDelimited,
  resolveCell,
  validateSheet,
} from "../../apps/web/src/sheet-data.js";
import { readWorkbook } from "../../apps/web/src/sheet-excel.js";
describe("spreadsheet input", () => {
  it("preserves codes, quoted newlines and empty cells", () => {
    expect(parseDelimited('001\t"秋季\n针织"\t\r\n002\t"a""b"\t0\r\n')).toEqual(
      [
        ["001", "秋季\n针织", ""],
        ["002", 'a"b', "0"],
      ],
    );
    expect(parseDelimited('code,name\r\n001,"a,b"', ",")).toEqual([
      ["code", "name"],
      ["001", "a,b"],
    ]);
  });
  it("validates numeric input without changing text identifiers", () => {
    expect(resolveCell("001", { key: "code", label: "编码" })).toBe("001");
    expect(() =>
      resolveCell("1.5", { key: "qty", label: "数量", type: "number" }),
    ).toThrow();
    expect(() =>
      resolveCell("9007199254740993", {
        key: "qty",
        label: "数量",
        type: "number",
      }),
    ).toThrow();
    expect(() =>
      resolveCell("-1", { key: "price", label: "金额", type: "money" }),
    ).toThrow();
    expect(
      validateSheet([{}], [{ key: "name", label: "名称", required: true }])
        .errors,
    ).toEqual({ "0:name": "必填项不能为空" });
  });
  it("refuses ambiguous names and accepts stable codes", () => {
    const col = {
      key: "categoryId",
      label: "品类",
      options: [
        { value: "1", label: "A · 上衣", aliases: ["上衣", "A"] },
        { value: "2", label: "B · 上衣", aliases: ["上衣", "B"] },
      ],
    };
    expect(() => resolveCell("上衣", col)).toThrow("重复");
    expect(resolveCell("B", col)).toBe("2");
  });
  it("pastes a rectangle without altering immutable document identifiers", () => {
    expect(
      applyMatrix(
        [{ sku: "A", qty: 1 }],
        [
          { key: "sku", label: "SKU", readonly: true },
          { key: "qty", label: "数量" },
        ],
        [["B", "5"]],
        0,
        0,
        true,
      ),
    ).toEqual([{ sku: "A", qty: "5" }]);
    expect(() =>
      applyMatrix([], [{ key: "a", label: "A" }], [["1", "2"]], 0, 0),
    ).toThrow("列数");
  });
  it("reads xlsx and retains zero-padded Excel code formats", async () => {
    const book = new Workbook(),
      sheet = book.addWorksheet("商品");
    sheet.addRow(["代码", "名称"]);
    sheet.addRow([1, "测试色"]);
    sheet.getCell("A2").numFmt = "000";
    const bytes = await book.xlsx.writeBuffer();
    const result = await readWorkbook(
      new File([bytes as BlobPart], "mapping.xlsx"),
    );
    expect(result[0].rows[1]).toEqual(["001", "测试色"]);
    sheet.getCell("B2").value = { formula: "1+1", result: 2 };
    await expect(
      readWorkbook(
        new File([(await book.xlsx.writeBuffer()) as BlobPart], "formula.xlsx"),
      ),
    ).rejects.toThrow("含公式");
  });
});
