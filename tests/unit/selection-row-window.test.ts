import { describe, expect, it } from "vitest";
import { selectionWindowEntries, sliceSelectionWindow, type SelectionWindowEntry } from "../../apps/web/src/selection-row-window.js";

type Row = { _key: string; value: number };
const rows = (count: number) => Array.from({ length: count }, (_, value) => ({ _key: `row-${value}`, value }));
const rowKeys = (entries: SelectionWindowEntry<Row>[]) => entries.filter((entry) => entry.kind === "row").map((entry) => entry.key);

function expectContinuousGeometry(entries: SelectionWindowEntry<Row>[], totalHeight: number) {
  let expectedTop = 0;
  for (const entry of entries) {
    expect(entry.top).toBe(expectedTop);
    expect(entry.height).toBeGreaterThan(0);
    expectedTop += entry.height;
  }
  expect(expectedTop).toBe(totalHeight);
  expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
}

describe("selection row viewport geometry", () => {
  it("accounts for group headers and keeps the original records and group counts", () => {
    const records = rows(4);
    const entries = selectionWindowEntries([
      { label: "", rows: records.slice(0, 1) },
      { label: "供应商 A", rows: records.slice(1, 3) },
      { label: "供应商 B", rows: records.slice(3) },
    ], 50);
    expectContinuousGeometry(entries, 4 * 50 + 2 * 34);
    expect(entries.filter((entry) => entry.kind === "group").map((entry) => ({ label: entry.label, count: entry.count, top: entry.top }))).toEqual([
      { label: "供应商 A", count: 2, top: 50 },
      { label: "供应商 B", count: 1, top: 184 },
    ]);
    const actualRows = entries.filter((entry) => entry.kind === "row");
    expect(actualRows.map((entry) => entry.row)).toEqual(records);
    actualRows.forEach((entry, index) => expect(entry.row).toBe(records[index]));
  });

  it("includes partially visible rows and excludes rows exactly outside each boundary", () => {
    const entries = selectionWindowEntries([{ label: "", rows: rows(6) }], 40);
    const exact = sliceSelectionWindow(entries, 40, 120, new Set());
    expect(rowKeys(exact)).toEqual(["row-1", "row-2"]);
    expectContinuousGeometry(exact, 240);
    const partial = sliceSelectionWindow(entries, 39, 121, new Set());
    expect(rowKeys(partial)).toEqual(["row-0", "row-1", "row-2", "row-3"]);
    expectContinuousGeometry(partial, 240);
  });

  it("retains distant editors without shifting row or group positions", () => {
    const records = rows(8);
    const entries = selectionWindowEntries([
      { label: "前组", rows: records.slice(0, 4) },
      { label: "后组", rows: records.slice(4) },
    ], 40);
    const output = sliceSelectionWindow(entries, 194, 274, new Set(["row-0", "row-7"]));
    expect(rowKeys(output)).toEqual(["row-0", "row-4", "row-5", "row-7"]);
    expect(output.filter((entry) => entry.kind === "group").map((entry) => entry.label)).toEqual(["后组"]);
    for (const entry of output.filter((entry) => entry.kind !== "spacer")) {
      const original = entries.find((candidate) => candidate.key === entry.key)!;
      expect(entry.top).toBe(original.top);
      expect(entry.height).toBe(original.height);
    }
    expectContinuousGeometry(output, 8 * 40 + 2 * 34);
  });

  it("replaces a completely offscreen page with one spacer and ignores stale pin keys", () => {
    const entries = selectionWindowEntries([{ label: "", rows: rows(10) }], 50);
    const output = sliceSelectionWindow(entries, 700, 800, new Set(["removed-row"]));
    expect(output).toEqual([{ kind: "spacer", key: "spacer:0", top: 0, height: 500 }]);
    expectContinuousGeometry(output, 500);
    expect(selectionWindowEntries([], 50)).toEqual([]);
    expect(sliceSelectionWindow([], 0, 500, new Set(["removed-row"]))).toEqual([]);
  });

  it.each([40, 50, 100, 120])("bounds a 1000-record page at row height %i while preserving full scroll height", (height) => {
    const records = rows(1000);
    const entries = selectionWindowEntries([{ label: "供应商", rows: records }], height);
    const totalHeight = 34 + records.length * height;
    const middle = Math.floor(totalHeight / 2);
    const output = sliceSelectionWindow(entries, middle - 400, middle + 720 + 400, new Set(["row-0", "row-999"]));
    expect(rowKeys(output).length).toBeLessThan(100);
    expect(rowKeys(output)[0]).toBe("row-0");
    expect(rowKeys(output).at(-1)).toBe("row-999");
    expectContinuousGeometry(output, totalHeight);
    const last = output.find((entry) => entry.key === "row-999")!;
    expect(last.top + last.height).toBe(totalHeight);
  });

  it.each([40, 50, 100, 120])("indexes a 5000-record page and retains distant controls at row height %i", height => {
    const entries = selectionWindowEntries([{ label: "供应商", rows: rows(5000) }], height);
    const positions = new Map(entries.map((entry, index) => [entry.key, index]));
    const output = sliceSelectionWindow(entries, 34 + 2500 * height, 34 + 2500 * height + 720, new Set(["row-0", "row-4999", "removed"]), positions);
    expect(rowKeys(output)).toEqual(["row-0", ...Array.from({ length: Math.ceil(720 / height) }, (_, i) => `row-${2500 + i}`), "row-4999"]);
    expectContinuousGeometry(output, 34 + 5000 * height);
    const tail = sliceSelectionWindow(entries, 34 + 4999 * height, 34 + 5000 * height, new Set(), positions);
    expect(rowKeys(tail)).toEqual(["row-4999"]);
    expectContinuousGeometry(tail, 34 + 5000 * height);
  });
});
