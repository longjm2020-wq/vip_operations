import { describe, it, expect } from "vitest";
import Excel from "exceljs";
import { createSelectionWorkbook, parseSelectionWorkbook, prepareSelectionWorkbookRecords } from "../../apps/web/src/selection-workbook.js";
import { selectionImportHeader, selectionImportTemplateFields } from "../../packages/contracts/src/selection-import-template.js";
const bytes = async (book: Awaited<ReturnType<typeof createSelectionWorkbook>>) => await book.xlsx.writeBuffer() as unknown as ArrayBuffer;
async function partialWorkbook(headers: string[], records: unknown[][]) {
  const book = new Excel.Workbook();
  const sheet = book.addWorksheet("选款资料");
  sheet.columns = headers.map((header, index) => ({ header, key: `column${index}`, style: { numFmt: "@" } }));
  records.forEach(record => sheet.addRow(record));
  return book;
}
describe("selection workbook", () => {
  it("round-trips styles, multiple images, legacy payloads, zero-prefixed codes and zero prices", async () => {
    const rows = [{ xutiStyleNo: "0001", supplierCode: "0010", registrationBatch: "2026-09-28", color: "黑/白", vipPrice: "0.00", images: [{ url: "https://example.test/a.png", color: "黑" }, { url: "data:image/png;base64," + "A".repeat(60000), color: "白" }], labelImages: [{ url: "https://example.test/wash-label.png", color: "" }, { url: "https://example.test/hang-tag.png", color: "" }] }];
    const book = await createSelectionWorkbook(rows);
    const parsed = await parseSelectionWorkbook(await bytes(book));
    expect(parsed[0]).toMatchObject({ xutiStyleNo: "0001", supplierCode: "0010", vipPrice: "0.00", registrationBatch: "2026-09-28" });
    expect(parsed[0].images.map(({ url, color }: any) => ({ url, color }))).toEqual(rows[0].images);
    expect(parsed[0].labelImages.map(({ url, color }: any) => ({ url, color }))).toEqual(rows[0].labelImages);
    expect(parsed[0]).not.toHaveProperty("material");
  });
  it("downloads a clean template and rejects duplicate styles and formulas", async () => {
    const book = await createSelectionWorkbook();
    expect(book.getWorksheet("选款资料")!.rowCount).toBe(1);
    book.getWorksheet("选款资料")!.addRow({ xutiStyleNo: "X" });
    book.getWorksheet("选款资料")!.addRow({ xutiStyleNo: "X" });
    await expect(parseSelectionWorkbook(await bytes(book))).rejects.toThrow("重复");
    book.getWorksheet("选款资料")!.getCell("D3").value = { formula: '"Y"', result: "Y" };
    await expect(parseSelectionWorkbook(await bytes(book))).rejects.toThrow("公式");
  });
  it("downloads the 24 standard template fields in order with read-only creation time and required style instructions", async () => {
    const book = await createSelectionWorkbook([], true), sheet = book.getWorksheet("选款资料")!;
    const labels = ["创建时间", "图片", "序缇款号", "三级类目", "供应商款号", "供应商编码", "供应商颜色", "标准颜色", "尺码范围", "成分", "洗唛/吊牌图", "安全类别", "执行标准", "洗涤标志核对", "面料材质核对", "是否豁免二次车缝", "衣服整改措施", "供货价（不含税）", "唯品价", "直播价", "吊牌价", "长标题", "短标题", "尺码表"];
    expect(sheet.columns.map(column => column.header)).toEqual(labels);
    expect(selectionImportTemplateFields.map(field => field.label)).toEqual(labels);
    expect(sheet.rowCount).toBe(1);
    expect(sheet.getCell("A1").note).toContain("系统只读字段");
    expect(sheet.getCell("C1").note).toContain("必填");
    const notes = book.getWorksheet("填写说明")!.getColumn(1).values.join("\n");
    expect(notes).toContain("覆盖更新或跳过不覆盖");
    expect(notes).toContain("任意一列或多列");
    expect(notes).toContain("新自定义字段默认排在模板默认字段之后");
    const reloaded = new Excel.Workbook();
    await reloaded.xlsx.load(await bytes(book));
    expect(JSON.stringify(reloaded.getWorksheet("选款资料")!.getCell("A1").note)).toContain("系统只读字段");
  });
  it("parses the new template plus custom columns without changing system creation time or splitting literal choice labels", async () => {
    const book = await createSelectionWorkbook([], true), sheet = book.getWorksheet("选款资料")!;
    sheet.addRow({ registrationBatch: "2020-01-01", xutiStyleNo: "0001", color: " 黑 / 白 / 黑 ", material: "羊毛100%", vipPrice: 0, "field:三级类目": "女士皮衣/皮草", "field:标准颜色": "米白", "field:长标题": "服装长标题", "field:尺码表": "S:90/M:94" });
    sheet.getCell("Y1").value = "自定义/备注";
    sheet.getCell("Y2").value = "甲/乙";
    sheet.getCell("Z1").value = "自定义数字";
    sheet.getCell("Z2").value = 0;
    const parsed = await parseSelectionWorkbook(await bytes(book));
    expect(parsed).toEqual([{ xutiStyleNo: "0001", color: "黑/白", material: "羊毛100%", vipPrice: "0", fieldValues: { "三级类目": "女士皮衣/皮草", "标准颜色": "米白", "长标题": "服装长标题", "尺码表": "S:90/M:94", "自定义/备注": "甲/乙", "自定义数字": "0" } }]);
    expect(parsed[0]).not.toHaveProperty("registrationBatch");
    expect(parsed[0]).not.toHaveProperty("extraFields");
  });
  it("supports style plus a single or multiple selected columns, retains zero and ignores blank rows and cells", async () => {
    const one = await partialWorkbook(["序缇款号", "直播价"], [["001", 0], ["002", ""], [" ", " "]]);
    expect(await parseSelectionWorkbook(await bytes(one))).toEqual([{ xutiStyleNo: "001", livePrice: "0" }, { xutiStyleNo: "002" }]);
    const many = await partialWorkbook(["短标题", "序缇款号", "材质成分", "自定义备注"], [["短标题", "003", "100%棉", "仅更新这几列"], ["", "004", "", ""]]);
    expect(await parseSelectionWorkbook(await bytes(many))).toEqual([{ xutiStyleNo: "003", material: "100%棉", fieldValues: { "短标题": "短标题", "自定义备注": "仅更新这几列" } }, { xutiStyleNo: "004" }]);
  });
  it("requires a style even when only creation time, a custom value or zero was filled and rejects formulas in ignored time cells", async () => {
    for (const [header, value] of [["创建时间", "2026-10-11"], ["自定义字段", "内容"], ["直播价", 0]] as const) {
      const book = await partialWorkbook(["序缇款号", header], [["", value]]);
      await expect(parseSelectionWorkbook(await bytes(book))).rejects.toThrow("第 2 行缺少序缇款号");
    }
    const book = await partialWorkbook(["序缇款号", "创建时间"], [["001", { formula: "TODAY()", result: 1 }]]);
    await expect(parseSelectionWorkbook(await bytes(book))).rejects.toThrow("公式");
    const noStyle = await partialWorkbook(["自定义字段"], [["内容"]]);
    await expect(parseSelectionWorkbook(await bytes(noStyle))).rejects.toThrow("缺少序缇款号列");
  });
  it("rejects duplicate equivalent headers and protects headerless or overly long custom columns", async () => {
    for (const aliases of [["颜色", "供应商颜色"], ["材质", "成分"], ["材质成分", "材质"], ["登记批次", "创建时间"], ["供货价(不含税)", "供货价（不含税）"], ["自定义", " 自定义 "]]) {
      const book = await partialWorkbook(["序缇款号", ...aliases], []);
      await expect(parseSelectionWorkbook(await bytes(book))).rejects.toThrow("表示同一字段");
    }
    const missingHeader = await partialWorkbook(["序缇款号", ""], [["001", 0]]);
    await expect(parseSelectionWorkbook(await bytes(missingHeader))).rejects.toThrow("第 2 列缺少表头");
    const invalidHeader = await partialWorkbook(["序缇款号", "长".repeat(41)], [["001", "内容"]]);
    await expect(parseSelectionWorkbook(await bytes(invalidHeader))).rejects.toThrow("最多40个字符");
    expect(selectionImportHeader("颜色")?.builtinKey).toBe("color");
    expect(selectionImportHeader("创建时间")?.readonly).toBe(true);
    expect(selectionImportHeader("登记批次")?.readonly).toBeUndefined();
  });
  it("supports more than 30 custom columns up to the 500 field limit and preserves special object property labels safely", async () => {
    const headers = ["序缇款号", "__proto__", "constructor", "xutiStyleNo", ...Array.from({ length: 496 }, (_, index) => `自定义${index}`)];
    const book = await partialWorkbook(headers, [["001", "原型名称", "构造名称", "另一个字段", ...Array.from({ length: 496 }, (_, index) => String(index))]]);
    const parsed = await parseSelectionWorkbook(await bytes(book));
    expect(Object.keys(parsed[0].fieldValues)).toHaveLength(499);
    expect(Object.hasOwn(parsed[0].fieldValues, "__proto__")).toBe(true);
    expect(parsed[0].fieldValues.__proto__).toBe("原型名称");
    expect(Object.getPrototypeOf(parsed[0].fieldValues)).toBe(Object.prototype);
    expect(parsed[0].fieldValues.xutiStyleNo).toBe("另一个字段");
    expect(parsed[0].fieldValues["自定义0"]).toBe("0");
    const tooMany = await partialWorkbook([...headers, "超限字段"], [["001"]]);
    await expect(parseSelectionWorkbook(await bytes(tooMany))).rejects.toThrow("最多 500 列");
  });
  it("retains picture safety validation for partial updates and duplicate style validation with custom columns", async () => {
    const invalidPicture = await partialWorkbook(["序缇款号", "图片"], [["001", "javascript:alert(1)"]]);
    await expect(parseSelectionWorkbook(await bytes(invalidPicture))).rejects.toThrow("图片URL须为");
    const duplicates = await partialWorkbook(["序缇款号", "自定义"], [["001", "A"], ["001", "B"]]);
    await expect(parseSelectionWorkbook(await bytes(duplicates))).rejects.toThrow("在文件中重复");
  });
  it("rejects invalid dates, picture-only unknown styles and missing codes", async () => {
    const book = await createSelectionWorkbook([{ xutiStyleNo: "X", registrationBatch: "2026-02-30" }]);
    await expect(parseSelectionWorkbook(await bytes(book))).rejects.toThrow("日期");
    book.getWorksheet("选款资料")!.getCell("A2").value = "2026-02-28";
    book.getWorksheet("图片明细")!.addRow({ style: "other", color: "", url: "https://example.test/a.png" });
    await expect(parseSelectionWorkbook(await bytes(book))).rejects.toThrow("对应款号");
    await expect(createSelectionWorkbook([{ material: "test" }])).rejects.toThrow("款号");
  });
  it("exports populated styles while ignoring blank drafts and their metadata or formatting", async () => {
    const rows = [
      { id: "1", xutiStyleNo: "001", vipPrice: "0" },
      { id: "2", productId: "9", sortOrder: 2, createdAt: "2026-10-10", rowColor: "BLUE", cellColors: { material: "BLUE" }, cellTextColors: { material: "#cf1322" }, images: [], labelImages: [], material: " \n ", extraFields: { "custom:photo": "[ ]", "custom:note": " " } },
      { id: "3", xutiStyleNo: "002", images: [{ url: "https://example.test/style.png" }] },
    ];
    const original = structuredClone(rows);
    const parsed = await parseSelectionWorkbook(await bytes(await createSelectionWorkbook(rows)));
    expect(parsed.map(row => row.xutiStyleNo)).toEqual(["001", "002"]);
    expect(parsed[0].vipPrice).toBe("0");
    expect(parsed[1].images[0].url).toBe("https://example.test/style.png");
    expect(rows).toEqual(original);
    expect(prepareSelectionWorkbookRecords([rows[1]])).toEqual([]);
  });
  it("reports populated missing-style records at their original export positions without dropping zero, images or custom data", async () => {
    const rows = [
      { xutiStyleNo: "001" },
      { id: "blank", cellColors: { material: "BLUE" } },
      { extraFields: { "custom:note": "only custom data" } },
      { vipPrice: 0 },
      { images: [{ url: "https://example.test/style.png" }], supplierStyleNo: "W8505", supplierCode: "A50" },
    ];
    await expect(createSelectionWorkbook(rows)).rejects.toThrow("有 3 条已填写内容的记录缺少序缇款号：第 3 条、第 4 条、第 5 条（供应商款号：W8505；供应商编码：A50）");
  });
  it("limits missing-style examples while reporting the full count and still rejects duplicate populated styles", async () => {
    const rows = Array.from({ length: 7 }, () => ({ material: "missing" }));
    expect(() => prepareSelectionWorkbookRecords(rows)).toThrow("有 7 条已填写内容的记录缺少序缇款号：第 1 条、第 2 条、第 3 条、第 4 条、第 5 条等");
    await expect(createSelectionWorkbook([{ xutiStyleNo: "DUP" }, {}, { xutiStyleNo: "DUP" }])).rejects.toThrow("存在多条记录");
  });
});
