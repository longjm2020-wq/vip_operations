import { describe, it, expect } from "vitest";
import { createSelectionWorkbook, parseSelectionWorkbook, prepareSelectionWorkbookRecords } from "../../apps/web/src/selection-workbook.js";
const bytes = async (book: Awaited<ReturnType<typeof createSelectionWorkbook>>) => await book.xlsx.writeBuffer() as unknown as ArrayBuffer;
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
