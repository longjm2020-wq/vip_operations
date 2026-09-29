import { describe, it, expect } from "vitest";
import { createSelectionWorkbook, parseSelectionWorkbook } from "../../apps/web/src/selection-workbook.js";
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
});
