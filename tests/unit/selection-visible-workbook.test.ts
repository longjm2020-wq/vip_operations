import { describe, expect, it } from "vitest";
import Excel from "exceljs";
import { selectionLayoutSchema, type SelectionField } from "../../packages/contracts/src/selection-layout.js";
import { defaultVipTagPriceLimitConfig } from "../../packages/contracts/src/selection-vip-tag-price-limit.js";
import {
  createVisibleSelectionWorkbook,
  prepareVisibleSelectionWorkbookRecords,
  visibleSelectionWorkbookFields,
} from "../../apps/web/src/selection-visible-workbook.js";

const field = (key: string, label: string, options: Partial<SelectionField> = {}): SelectionField => ({
  key, label, width: 120, type: "text", ...options,
});
const reload = async (book: Awaited<ReturnType<typeof createVisibleSelectionWorkbook>>) => {
  const copy = new Excel.Workbook();
  await copy.xlsx.load(await book.xlsx.writeBuffer());
  return copy;
};
const rowValues = (row: Excel.Row) => Array.isArray(row.values) ? row.values.slice(1) : [];
const sheetText = (book: Excel.Workbook) => JSON.stringify(book.worksheets.map(sheet => ({
  name: sheet.name, rows: Array.from({ length: sheet.rowCount }, (_, index) => sheet.getRow(index + 1).values),
})));

describe("visible selection workbook", () => {
  it("exports current headers and order with custom, system, image and reference values in a real XLSX", async () => {
    const columns = [
      field("custom:tags", "标准颜色", { custom: true, type: "tags" }),
      field("xutiStyleNo", "款号（已改名）"),
      field("custom:amount", "核价", { custom: true, type: "currency" }),
      field("supplierCode", "供应商编码"),
      field("custom:creator", "创建人", { custom: true, type: "creator", personDisplay: "both" }),
      field("custom:created", "创建日期", { custom: true, type: "createdTime", timeDisplay: "date" }),
      field("custom:number", "编号", { custom: true, type: "autonumber", numberConfig: { prefix: "ST-", suffix: "", digits: 4 } }),
      field("collectionInventory", "库存数", { type: "number" }),
      field("custom:product:categoryId", "分类", { custom: true, type: "single" }),
      field("custom:product:status", "商品状态", { custom: true, type: "single" }),
      field("custom:check", "检查完成", { custom: true, type: "checkbox" }),
      field("images", "款图", { type: "image" }),
      field("custom:photos", "证据图片", { custom: true, type: "image" }),
    ];
    const legacyImage = "data:image/png;base64," + "A".repeat(60000);
    const records = [{
      id: "7", xutiStyleNo: "0001", supplierCode: "0007", createdBy: "9", createdByName: "甲", createdByUsername: "editor-a",
      createdAt: "2026-10-10T00:00:00.000Z", collectionInventory: [{ available: 2, production: 3 }, { available: 0, production: 4 }],
      images: [{ url: "https://example.test/style.png", color: "红" }],
      extraFields: { "custom:tags": "红/金", "custom:amount": 0, "custom:product:categoryId": "42", "custom:product:status": "ACTIVE", "custom:check": false, "custom:photos": JSON.stringify([{ id: "custom-photo", url: legacyImage, color: "" }]) },
    }, { id: "8", createdAt: "2026-10-10T00:00:00.000Z", extraFields: {}, images: [], cellColors: { supplierCode: "RED" } }];
    const original = structuredClone(records);
    const book = await reload(await createVisibleSelectionWorkbook(records, columns, {
      archiveReferences: { categoryId: [{ id: "42", name: "针织衫" }] },
    }));
    const sheet = book.getWorksheet("表格资料")!;
    expect(sheet.rowCount).toBe(2);
    expect(rowValues(sheet.getRow(1))).toEqual(columns.map(column => column.label));
    expect(rowValues(sheet.getRow(2))).toEqual([
      "红/金", "0001", "0", "0007", "甲（editor-a）", "2026-10-10", "ST-0007", "9", "针织衫", "在用", "否", "见图片明细", "见图片明细",
    ]);
    expect(sheet.getCell("B2").numFmt).toBe("@");
    const pictures = book.getWorksheet("图片明细")!;
    expect(pictures.rowCount).toBe(3);
    expect(rowValues(pictures.getRow(1))).toEqual(["资料行", "字段位置", "字段", "序缇款号", "颜色", "图片URL"]);
    expect(rowValues(pictures.getRow(2))).toEqual(["2", "12", "款图", "0001", "红", "https://example.test/style.png"]);
    expect(rowValues(pictures.getRow(3))).toEqual(["2", "13", "证据图片", "0001", "", "内嵌图片:1"]);
    const content = book.getWorksheet("图片内容")!;
    expect(content.state).toBe("hidden");
    expect(Array.from({ length: content.rowCount }, (_, index) => content.getRow(index + 1).getCell(3).text).join("")).toBe(legacyImage);
    expect(records).toEqual(original);
  });

  it("exports complete URLs for every image field and associates each image with its own row's style", async () => {
    const columns = [field("xutiStyleNo", "改名后的款号"), field("images", "图片", { type: "image" }), field("labelImages", "洗唛/吊牌图", { type: "image" }), field("custom:photos", "尺码图", { custom: true, type: "image" })];
    const path = "/api/v1/style-selections/images/f5d50408-cc47-46d5-97bc-6e3d54f9fcf8?tableId=3";
    const records = [{ id: "1", xutiStyleNo: "0007", images: [{ url: path, color: "红" }], labelImages: [{ url: path }], extraFields: { "custom:photos": JSON.stringify([{ id: "size-image", url: "//cdn.example.test/size.jpg?size=1%2F2", color: "" }]) } },
      { id: "2", xutiStyleNo: "0007", images: [{ url: "https://elsewhere.test/other.jpg?a=1%2F2" }] },
      { id: "3", images: [{ url: path }] }];
    const original = structuredClone(records);
    const book = await reload(await createVisibleSelectionWorkbook(records, columns, { imageOrigin: "https://current.example.test:8443" }));
    const pictures = book.getWorksheet("图片明细")!;
    expect(Array.from({ length: 5 }, (_, index) => rowValues(pictures.getRow(index + 2)))).toEqual([
      ["2", "2", "图片", "0007", "红", `https://current.example.test:8443${path}`],
      ["2", "3", "洗唛/吊牌图", "0007", "", `https://current.example.test:8443${path}`],
      ["2", "4", "尺码图", "0007", "", "https://cdn.example.test/size.jpg?size=1%2F2"],
      ["3", "2", "图片", "0007", "", "https://elsewhere.test/other.jpg?a=1%2F2"],
      ["4", "2", "图片", "", "", `https://current.example.test:8443${path}`],
    ]);
    expect(pictures.getCell("D2").numFmt).toBe("@");
    expect(records).toEqual(original);
  });

  it("never discloses a denied, hidden or omitted style number through image details", async () => {
    const columns = [field("xutiStyleNo", "序缇款号"), field("images", "图片", { type: "image" })];
    const records = [
      { id: "1", xutiStyleNo: "DENIED_STYLE", cellAccess: { xutiStyleNo: "deny" } },
      { id: "2", xutiStyleNo: "HIDDEN_STYLE", hiddenCells: ["xutiStyleNo"] },
      { id: "3", xutiStyleNo: "DEFAULT_DENIED_STYLE", defaultCellAccess: "deny", cellAccess: { images: "read" } },
    ].map(record => ({ ...record, images: [{ url: "https://example.test/allowed.jpg" }] }));
    const book = await reload(await createVisibleSelectionWorkbook(records, columns));
    expect(book.getWorksheet("图片明细")!.getColumn(4).values.slice(2)).toEqual(["••••", "••••", "••••"]);
    for (const record of records) expect(sheetText(book)).not.toContain(record.xutiStyleNo);
    for (const styleColumns of [[], [{ ...columns[0], deleted: true }]]) {
      const omitted = await reload(await createVisibleSelectionWorkbook([{ id: "4", xutiStyleNo: "OMITTED_STYLE", images: [{ url: "https://example.test/allowed.jpg" }] }], [...styleColumns, columns[1]]));
      expect(omitted.getWorksheet("图片明细")!.getCell("D2").text).toBe("");
      expect(sheetText(omitted)).not.toContain("OMITTED_STYLE");
    }
  });

  it("intersects active columns with fresh field definitions without restoring hidden, deleted or revoked fields", () => {
    const active = [field("custom:private", "私有备注", { custom: true }), field("supplierCode", "旧编码"), field("images", "图片"), field("custom:creator", "创建人", { custom: true, type: "creator" }), field("material", "旧成分")];
    const fresh = selectionLayoutSchema.parse({
      columns: [field("material", "成分"), field("images", "图片"), field("supplierCode", "供应商编码"), field("custom:creator", "创建人", { custom: true, type: "creator", deleted: true })],
      hiddenColumns: ["images"],
    });
    expect(visibleSelectionWorkbookFields(active, fresh).map(column => [column.key, column.label])).toEqual([["supplierCode", "供应商编码"], ["material", "成分"]]);
    expect(visibleSelectionWorkbookFields(active, null).map(column => column.key)).toEqual(["supplierCode", "images", "material"]);
  });

  it("exports current derived price limits from category labels and archive references without stale or denied source values", async () => {
    const columns = [
      field("custom:limit", "唯品吊牌限价", { custom: true, type: "vipTagPriceLimit", vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig("custom:category") }),
      field("custom:archive-limit", "商品分类吊牌限价", { custom: true, type: "vipTagPriceLimit", vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig("custom:product:categoryId") }),
    ];
    const extraFields = { "custom:category": "半截裙", "custom:product:categoryId": "42", "custom:limit": "STALE_SAVED_LIMIT", "custom:archive-limit": "STALE_ARCHIVE_LIMIT" };
    const cellAccess = { "custom:limit": "read", "custom:archive-limit": "read", "custom:category": "read", "custom:product:categoryId": "read" };
    const records = [
      { id: "1", extraFields: { ...extraFields }, cellAccess: { ...cellAccess } },
      { id: "2", extraFields: { ...extraFields }, cellAccess: { ...cellAccess, "custom:category": "deny", "custom:product:categoryId": "deny" } },
      { id: "3", extraFields: { ...extraFields, "custom:category": "尚未配置类目", "custom:product:categoryId": "99" }, cellAccess: { ...cellAccess } },
    ];
    const original = structuredClone(records);
    const book = await reload(await createVisibleSelectionWorkbook(records, columns, { archiveReferences: { categoryId: [{ id: "42", name: "女式马夹" }] } }));
    const sheet = book.getWorksheet("表格资料")!;
    expect(rowValues(sheet.getRow(2))).toEqual(["899", "1299"]);
    expect(rowValues(sheet.getRow(3))).toEqual(["", ""]);
    expect(rowValues(sheet.getRow(4))).toEqual(["", ""]);
    expect(sheetText(book)).not.toContain("STALE_");
    expect(records).toEqual(original);
  });

  it("masks forbidden cells and omits undeclared fields and pictures from every serialized worksheet", async () => {
    const columns = [field("xutiStyleNo", "款号"), field("material", "成分"), field("custom:note", "备注", { custom: true }), field("images", "图片", { type: "image" })];
    const records = [{
      id: "1", xutiStyleNo: "SAME", material: "HIDDEN_MATERIAL", images: [{ url: "https://example.test/DENIED_PICTURE.png" }],
      labelImages: [{ url: "https://example.test/OMITTED_LABEL.png" }], hiddenCells: ["material"],
      cellAccess: { xutiStyleNo: "read", material: "deny", images: "deny" },
      extraFields: { "custom:note": "REVOKED_PRIVATE_VALUE", "custom:unselected": "UNSELECTED_VALUE" },
    }, { id: "2", hiddenCells: ["material"], cellAccess: { material: "deny" }, images: [], extraFields: {} }];
    const book = await reload(await createVisibleSelectionWorkbook(records, columns));
    const sheet = book.getWorksheet("表格资料")!;
    expect(sheet.rowCount).toBe(3);
    expect(rowValues(sheet.getRow(2))).toEqual(["SAME", "••••", "••••", "••••"]);
    expect(sheet.getCell("B3").text).toBe("••••");
    const text = sheetText(book);
    for (const secret of ["HIDDEN_MATERIAL", "DENIED_PICTURE", "OMITTED_LABEL", "REVOKED_PRIVATE_VALUE", "UNSELECTED_VALUE"]) expect(text).not.toContain(secret);
    expect(book.getWorksheet("图片内容")).toBeUndefined();
    expect(book.getWorksheet("图片明细")?.rowCount ?? 1).toBe(1);
  });

  it("allows missing and repeated style numbers in snapshots while skipping only raw empty drafts", async () => {
    const columns = [field("xutiStyleNo", "款号"), field("vipPrice", "价格", { type: "currency" }), field("custom:note", "备注", { custom: true }), field("custom:created", "创建时间", { custom: true, type: "createdTime" })];
    const records = [{ id: "1", xutiStyleNo: "DUP" }, { id: "2", xutiStyleNo: "DUP" }, { id: "3", vipPrice: 0 }, { id: "4", extraFields: { "custom:note": "缺号也有内容" } }, { id: "5", createdAt: "2026-10-10T00:00:00.000Z", extraFields: { "custom:note": " " }, images: [], labelImages: [] }];
    expect(prepareVisibleSelectionWorkbookRecords(records, columns).map(row => row.id)).toEqual(["1", "2", "3", "4"]);
    const book = await reload(await createVisibleSelectionWorkbook(records, columns));
    expect(book.getWorksheet("表格资料")!.rowCount).toBe(5);
    expect(book.getWorksheet("表格资料")!.getColumn(1).values.slice(2)).toEqual(["DUP", "DUP", "", ""]);
    expect(book.getWorksheet("表格资料")!.getCell("B4").text).toBe("0");
    expect(book.getWorksheet("表格资料")!.getCell("C5").text).toBe("缺号也有内容");
  });
});
