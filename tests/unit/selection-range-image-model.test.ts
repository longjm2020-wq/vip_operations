import { describe, expect, it } from "vitest";
import {
  buildSelectionRangeImageTable,
  selectionRangeHeaderText,
} from "../../apps/web/src/selection-range-image-model.js";
import type { SelectionField } from "../../packages/contracts/src/selection-layout.js";

const columns: SelectionField[] = [
  { key: "xutiStyleNo", label: "序缇款号", width: 110 },
  { key: "images", label: "图片", width: 100 },
  { key: "registrationBatch", label: "创建时间", width: 120, type: "createdTime", timeDisplay: "date" },
];
const model = (rows: Record<string, any>[], selected: string[], extra: Record<string, any> = {}) =>
  buildSelectionRangeImageTable({ rows, columns, selectedCells: new Set(selected), rowHeight: 120, ...extra });

describe("selection range image content", () => {
  it("follows display order and leaves unselected holes blank without reading their data", () => {
    const first = { _key: "b", xutiStyleNo: "STYLE-B", createdAt: "2026-10-05T00:00:00Z" };
    Object.defineProperty(first, "images", { get() { throw new Error("unselected image read"); } });
    const table = model([first, { _key: "a", xutiStyleNo: "UNSELECTED-SECRET", createdAt: "2026-10-06T00:00:00Z" }], ["b::xutiStyleNo", "a::registrationBatch"]);
    expect(table.columns.map(column => column.label)).toEqual(["序缇款号", "图片", "创建时间"]);
    expect(table.rows.map(row => row.key)).toEqual(["b", "a"]);
    expect(table.rows[0].cells.map(cell => cell.text)).toEqual(["STYLE-B", "", ""]);
    expect(table.rows[1].cells.map(cell => cell.text)).toEqual(["", "", "2026-10-06"]);
    expect(JSON.stringify(table)).not.toContain("UNSELECTED-SECRET");
  });

  it("masks stale denied values, hidden cells and unavailable private fields before resolving images or system values", () => {
    const privateField: SelectionField = { key: "custom:secret", label: "私有资料", width: 100, custom: true, type: "text" };
    const table = model([{ _key: "a", xutiStyleNo: "STALE-SECRET", images: [{ url: "https://example.com/SECRET.png" }],
      createdAt: "2026-10-05T00:00:00Z", extraFields: { "custom:secret": "PRIVATE-SECRET" },
      cellAccess: { xutiStyleNo: "edit", images: "deny" }, defaultCellAccess: "deny", hiddenCells: ["xutiStyleNo"],
    }], columns.concat(privateField).map(column => `a::${column.key}`), { columns: [...columns, privateField] });
    expect(table.rows[0].cells.map(cell => cell.text)).toEqual(["••••", "••••", "••••", "••••"]);
    expect(JSON.stringify(table)).not.toContain("SECRET");
    expect(table.rows[0].cells.every(cell => !cell.image)).toBe(true);
  });

  it("uses only the authorized current carousel choice and preserves the image count", () => {
    const row = { _key: "a", images: [{ url: "/first.png", color: "白" }, { url: "/second.png", color: "黑" }] };
    expect(model([row], ["a::images"], { shownImages: new Map([["a::images", { url: "/second.png" }]]) }).rows[0].cells[0].image)
      .toMatchObject({ url: "/second.png", badge: "2/2", label: "黑" });
    expect(model([row], ["a::images"], { shownImages: new Map([["a::images", { url: "/UNAUTHORIZED.png" }]]) }).rows[0].cells[0].image?.url)
      .toBe("/first.png");
  });

  it("does not disclose a protected linked colour through the photo caption", () => {
    const row = { _key: "a", images: [{ url: "/allowed.png", color: "PRIVATE-COLOUR", colorFieldKey: "color" }], cellAccess: { images: "read", color: "deny" } };
    expect(model([row], ["a::images"]).rows[0].cells[0].image?.url).toBe("/allowed.png");
    expect(JSON.stringify(model([row], ["a::images"]))).not.toContain("PRIVATE-COLOUR");
    const protectedLink = { ...row, cellAccess: { images: "read" }, images: [{ url: "/allowed.png", color: "PRIVATE-COLOUR", colorFieldKey: "protected" }] };
    expect(JSON.stringify(model([protectedLink], ["a::images"]))).not.toContain("PRIVATE-COLOUR");
    expect(JSON.stringify(model([{ ...protectedLink, cellAccess: undefined }], ["a::images"]))).not.toContain("PRIVATE-COLOUR");
  });

  it("preserves zero and the configured cell colours and alignment for read-only copying", () => {
    const table = model([{ _key: "a", xutiStyleNo: 0, cellAccess: { xutiStyleNo: "read" },
      cellColors: { xutiStyleNo: "GREEN" }, cellTextColors: { xutiStyleNo: "#cf1322" },
      cellAlignments: { xutiStyleNo: "left" }, cellVerticalAlignments: { xutiStyleNo: "bottom" },
    }], ["a::xutiStyleNo"]);
    expect(table.rows[0].cells[0]).toMatchObject({ text: "0", background: "#eef9e8", color: "#cf1322", align: "left", verticalAlign: "bottom" });
  });

  it("copies header labels in display order and supports an empty table", () => {
    expect(selectionRangeHeaderText(columns, ["registrationBatch", "xutiStyleNo"])).toBe("序缇款号\t创建时间");
    const table = model([], [], { headerKeys: ["registrationBatch", "xutiStyleNo"] });
    expect(table.columns.map(column => column.key)).toEqual(["xutiStyleNo", "registrationBatch"]);
    expect(table.rows).toEqual([]);
  });
});
