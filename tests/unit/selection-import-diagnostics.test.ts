import { describe, expect, it } from "vitest";
import Excel from "exceljs";
import { parseSelectionWorkbook } from "../../apps/web/src/selection-workbook.js";
import { formatSelectionImportError } from "../../apps/web/src/selection-import-diagnostics.js";
import type { SelectionImportImageColorDiagnostic } from "../../packages/contracts/src/selection-import-diagnostics.js";

function bookWithHeaders(headers: string[]) {
  const book = new Excel.Workbook(), sheet = book.addWorksheet("选款资料");
  sheet.addRow(headers);
  return { book, sheet };
}
const parse = async (book: Excel.Workbook) => parseSelectionWorkbook(await book.xlsx.writeBuffer() as unknown as ArrayBuffer);
function error(overrides: Partial<SelectionImportImageColorDiagnostic> = {}) {
  return Object.assign(Error("服务器校验提示"), { details: {
    kind: "SELECTION_IMPORT_IMAGE_COLOR", rowIndex: 0, xutiStyleNo: "STYLE-001", imageIndex: 0,
    imageSource: "import", colorSource: "import", imageColor: "灰", allowedColors: ["黑", "白"], ...overrides,
  } satisfies SelectionImportImageColorDiagnostic });
}

describe("selection import color diagnostics", () => {
  it("locates the standard color cell independently of supplier colors and retains protected-value redaction", async () => {
    const { book, sheet } = bookWithHeaders(["标准颜色", "序缇款号", "供应商颜色"]);
    sheet.getRow(17).values = ["白色", "STYLE-001", "供应商粉"];
    const pictures = book.addWorksheet("图片明细");
    pictures.addRow(["序缇款号", "标准颜色", "图片URL"]);
    pictures.getRow(778).values = ["STYLE-001", "粉色", "https://example.test/pink.jpg"];
    const records = await parse(book);
    const failure = error({ colorFieldLabel: "标准颜色", imageColor: "粉色", allowedColors: ["白色"] });
    expect(formatSelectionImportError(failure, records)).toBe("图片明细第 778 行（颜色单元格 B778），序缇款号「STYLE-001」的图片颜色「粉色」不符合标准颜色；对应选款资料第 17 行（标准颜色单元格 A17）；可用颜色：白色。请核对图片颜色和该款标准颜色后重新上传。");
    expect(formatSelectionImportError(error({ colorFieldLabel: "标准颜色", colorSource: "existing" }), records)).toContain("本次沿用系统已有标准颜色");
    const redacted = formatSelectionImportError(error({ colorFieldLabel: "标准颜色", imageColor: undefined, allowedColors: undefined }), records);
    expect(redacted).not.toContain("白色");
    expect(redacted).not.toContain("供应商粉");
    expect(redacted).not.toContain("可用颜色");
  });
  it("reports sparse worksheet coordinates for the correct style and image, not import array ordinals", async () => {
    const { book, sheet } = bookWithHeaders(["序缇款号", "图片", "自定义", "供应商颜色"]);
    sheet.getRow(3).values = ["OTHER-STYLE", "", "", "黑"];
    sheet.getRow(8).values = ["STYLE-001", "", "", "黑/白"];
    sheet.getRow(1000).height = 26;
    const pictures = book.addWorksheet("图片明细");
    pictures.addRow(["序缇款号", "颜色", "图片URL"]);
    pictures.getRow(4).values = ["OTHER-STYLE", "黑", "https://example.test/other.jpg"];
    pictures.getRow(11).values = ["STYLE-001", "黑", "https://example.test/first.jpg"];
    pictures.getRow(19).values = ["STYLE-001", "灰", "https://example.test/second.jpg"];
    const records = await parse(book);
    // Parsing does not enforce server-side merge or skip rules.
    expect(records[1].images[1].color).toBe("灰");
    expect(formatSelectionImportError(error({ rowIndex: 1, imageIndex: 1 }), records)).toBe("图片明细第 19 行（颜色单元格 B19），序缇款号「STYLE-001」的图片颜色「灰」不符合供应商颜色；对应选款资料第 8 行（供应商颜色单元格 D8）；可用颜色：黑、白。请核对图片颜色和该款供应商颜色后重新上传。");
    expect(Object.keys(records[1])).toEqual(["xutiStyleNo", "color", "images"]);
    expect(Object.getOwnPropertySymbols(records[1])).toEqual([]);
    expect(JSON.parse(JSON.stringify(records[1]))).toEqual(records[1]);
  });

  it("locates inline image contents including leading and intervening blank lines without changing parsed values", async () => {
    const { book, sheet } = bookWithHeaders(["图片", "供应商颜色", "序缇款号"]);
    sheet.getRow(6).values = ["\n黑 | https://example.test/first.jpg\n\n灰 | https://example.test/second.jpg\n", "黑", "STYLE-001"];
    const records = await parse(book);
    expect(records[0].images.map(({ color, url }: any) => ({ color, url }))).toEqual([
      { color: "黑", url: "https://example.test/first.jpg" }, { color: "灰", url: "https://example.test/second.jpg" },
    ]);
    const result = formatSelectionImportError(error({ imageIndex: 1, allowedColors: ["黑"] }), records);
    expect(result).toContain("选款资料第 6 行（图片单元格 A6，第 4 行内容）");
    expect(result).toContain("对应选款资料第 6 行（供应商颜色单元格 B6）；可用颜色：黑");
  });

  it("uses the actual old or reordered new supplier color header rather than a fixed template column", async () => {
    for (const [headers, values, cell, label] of [
      [["序缇款号", "颜色", "图片"], ["STYLE-001", "黑", "灰 | https://example.test/image.jpg"], "B9", "颜色"],
      [["供应商颜色", "图片", "序缇款号"], ["黑", "灰 | https://example.test/image.jpg", "STYLE-001"], "A9", "供应商颜色"],
    ] as const) {
      const { book, sheet } = bookWithHeaders([...headers]);
      sheet.getRow(9).values = [...values];
      const records = await parse(book);
      expect(formatSelectionImportError(error(), records)).toContain(`对应选款资料第 9 行（${label}单元格 ${cell}）`);
    }
  });

  it("identifies retained system images without inventing a picture detail row", async () => {
    const { book, sheet } = bookWithHeaders(["供应商颜色", "序缇款号"]);
    sheet.getRow(12).values = ["黑", "STYLE-001"];
    const records = await parse(book);
    const result = formatSelectionImportError(error({ imageSource: "existing", imageIndex: 2, imageColor: "白", allowedColors: ["黑"] }), records);
    expect(result).toBe("系统已有第 3 张图片，序缇款号「STYLE-001」的图片颜色「白」不符合供应商颜色；对应选款资料第 12 行（供应商颜色单元格 A12）；可用颜色：黑。请保留已有图片对应的颜色，或同时导入颜色匹配的新图片后重新上传。");
    expect(result).not.toContain("图片明细");
  });

  it("distinguishes omitted new colors from preserved existing colors and a blank provided color cell", async () => {
    const { book, sheet } = bookWithHeaders(["序缇款号", "图片"]);
    sheet.getRow(7).values = ["STYLE-001", "灰 | https://example.test/image.jpg"];
    const records = await parse(book);
    expect(formatSelectionImportError(error({ allowedColors: [] }), records)).toContain("对应选款资料第 7 行，本次文件未提供供应商颜色列；当前供应商颜色为空");
    const existing = formatSelectionImportError(error({ colorSource: "existing", allowedColors: ["黑"] }), records);
    expect(existing).toContain("本次沿用系统已有供应商颜色；可用颜色：黑");
    expect(existing).not.toContain("未提供");
    sheet.getCell("C1").value = "颜色";
    const withBlank = await parse(book);
    expect(formatSelectionImportError(error({ allowedColors: [] }), withBlank)).toContain("对应选款资料第 7 行（颜色单元格 C7）；当前供应商颜色为空");
  });

  it("does not reconstruct protected colors omitted by the API from the local workbook", async () => {
    const { book, sheet } = bookWithHeaders(["序缇款号", "供应商颜色", "图片"]);
    sheet.getRow(2).values = ["STYLE-001", "颜色字段保密值", "图片保密值 | https://example.test/image.jpg"];
    const records = await parse(book);
    const result = formatSelectionImportError(error({ imageColor: undefined, allowedColors: undefined }), records);
    expect(result).toContain("的图片颜色不符合供应商颜色");
    expect(result).not.toContain("颜色字段保密值");
    expect(result).not.toContain("图片保密值");
    expect(result).not.toContain("可用颜色");
    const retained = formatSelectionImportError(error({ imageSource: "existing", imageColor: undefined, allowedColors: undefined }), records);
    expect(retained).toContain("系统已有第 1 张图片");
    expect(retained).not.toContain("保密值");
    const redacted = formatSelectionImportError(error({ imageSource: "existing", imageIndex: undefined, imageColor: undefined, allowedColors: undefined }), records);
    expect(redacted).toContain("系统已有图片，序缇款号「STYLE-001」的图片颜色不符合供应商颜色");
    expect(redacted).not.toMatch(/系统已有第 \d+ 张图片/);
    expect(redacted).not.toContain("保密值");
  });

  it("preserves provenance across preview retries and embedded URL replacement but never serializes it", async () => {
    const { book, sheet } = bookWithHeaders(["序缇款号", "供应商颜色", "图片"]);
    sheet.getRow(5).values = ["STYLE-001", "黑", "灰 | data:image/png;base64,AAAA"];
    const records = await parse(book), first = formatSelectionImportError(error(), records);
    records[0].images[0].url = "/api/v1/style-selections/images/00000000-0000-4000-8000-000000000001";
    expect(formatSelectionImportError(error(), records)).toBe(first);
    expect(formatSelectionImportError(error(), records)).toBe(first);
    const payload = JSON.stringify({ rows: records, existingStrategy: "OVERWRITE" });
    expect(payload).not.toContain("cell");
    expect(payload).not.toContain("source");
    expect(payload).not.toContain("rowIndex");
    expect(formatSelectionImportError(error(), JSON.parse(payload).rows)).toBe("服务器校验提示");
  });

  it("retains server fallback for stale indices, styles, lost provenance and unrelated errors", async () => {
    const { book, sheet } = bookWithHeaders(["序缇款号", "供应商颜色", "图片"]);
    sheet.getRow(2).values = ["STYLE-001", "黑", "灰 | https://example.test/image.jpg"];
    const records = await parse(book);
    for (const failure of [error({ rowIndex: 1 }), error({ imageIndex: 1 }), error({ xutiStyleNo: "OTHER" }),
      Object.assign(Error("服务器校验提示"), { details: { ...error().details, kind: "OTHER" } }),
      Object.assign(Error("服务器校验提示"), { details: { ...error().details, imageIndex: -1 } }),
      Object.assign(Error("服务器校验提示"), { details: [error().details] }), Error("服务器校验提示")]) {
      expect(formatSelectionImportError(failure, records)).toBe("服务器校验提示");
    }
    expect(formatSelectionImportError(error(), [{ ...records[0] }])).toBe("服务器校验提示");
    expect(formatSelectionImportError(error(), null)).toBe("服务器校验提示");
    records[0].xutiStyleNo = "OTHER";
    expect(formatSelectionImportError(error({ xutiStyleNo: "OTHER" }), records)).toBe("服务器校验提示");
  });
});
