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
  it("reads displayed percentages and dates for inventory imports", async () => {
    const book = new Workbook(),
      sheet = book.addWorksheet("数据");
    sheet.addRow(["商品编码", "退货率", "参考日期"]);
    sheet.addRow([1, 0.015, new Date("2026-10-01T00:00:00Z")]);
    sheet.getCell("A2").numFmt = "00000";
    sheet.getCell("B2").numFmt = "0.00%";
    const result = await readWorkbook(
      new File([(await book.xlsx.writeBuffer()) as BlobPart], "inventory.xlsx"),
      { formattedCells: true },
    );
    expect(result[0].rows[1]).toEqual(["00001", "1.5%", "2026-10-01"]);
  });

  it("only reads saved VLOOKUP image URLs when the image column is explicitly enabled", async () => {
    const book = new Workbook(), sheet = book.addWorksheet("数据");
    sheet.addRow([" 图 \n片 ", "商品编码"]);
    sheet.addRow([{ formula: "VLOOKUP(B2,[1]Sheet1!$B:$C,2,FALSE)", result: " https://example.com/product.jpg " }, "SKU-001"]);
    const file = new File([(await book.xlsx.writeBuffer()) as BlobPart], "cached-images.xlsx");
    await expect(readWorkbook(file)).rejects.toThrow("A2 含公式");
    await expect(readWorkbook(file, { cachedImageFormulaColumns: ["图片链接"] })).rejects.toThrow("A2 含公式");
    const result = await readWorkbook(file, { cachedImageFormulaColumns: ["图片"] });
    expect(result[0].rows[1]).toEqual(["https://example.com/product.jpg", "SKU-001"]);
  });

  it.each([
    ["missing", undefined],
    ["error", { error: "#N/A" }],
    ["empty", ""],
    ["non-URL", "picture.jpg"],
    ["incomplete URL", "https://"],
    ["non-HTTP scheme", "javascript:alert(1)"],
    ["number", 12],
    ["too long URL", "https://example.com/" + "a".repeat(2048)],
  ])("rejects an image formula with a %s cache and explains how to supply an image link", async (_, result) => {
    const book = new Workbook(), sheet = book.addWorksheet("数据");
    sheet.addRow(["图片", "商品编码"]);
    sheet.addRow([{ formula: "VLOOKUP(B2,[1]Sheet1!$B:$C,2,FALSE)", result } as ExcelJS.CellFormulaValue, "SKU-001"]);
    const file = new File([(await book.xlsx.writeBuffer()) as BlobPart], "invalid-image-cache.xlsx");
    await expect(readWorkbook(file, { cachedImageFormulaColumns: ["图片"] }))
      .rejects.toThrow("A2 的图片公式没有有效的 http/https 链接缓存");
  });

  it("does not enable cached numeric formulas in other columns", async () => {
    const book = new Workbook(), sheet = book.addWorksheet("数据");
    sheet.addRow(["图片", "在仓库存数"]);
    sheet.addRow([{ formula: "VLOOKUP(C2,[1]Sheet1!$B:$C,2,FALSE)", result: "http://example.com/product.jpg" }, { formula: "1+2", result: 3 }]);
    const file = new File([(await book.xlsx.writeBuffer()) as BlobPart], "stock-formula.xlsx");
    await expect(readWorkbook(file, { cachedImageFormulaColumns: ["图片"] }))
      .rejects.toThrow("B2 含公式");
  });

  it("reads a valid saved URL from a shared image formula without evaluating the shared formula", async () => {
    const book = new Workbook(), sheet = book.addWorksheet("数据");
    sheet.addRow(["图片链接", "商品编码"]);
    sheet.addRow([{ formula: "VLOOKUP(B2,[1]Sheet1!$B:$C,2,FALSE)", shareType: "shared", ref: "A2:A3", result: "http://example.com/one.jpg" }, "SKU-001"]);
    sheet.addRow([{ sharedFormula: "A2", result: "https://example.com/two.jpg" }, "SKU-002"]);
    const file = new File([(await book.xlsx.writeBuffer()) as BlobPart], "shared-image-cache.xlsx");
    const result = await readWorkbook(file, { cachedImageFormulaColumns: [" 图片 链接 "] });
    expect(result[0].rows.slice(1)).toEqual([
      ["http://example.com/one.jpg", "SKU-001"],
      ["https://example.com/two.jpg", "SKU-002"],
    ]);
  });
});
