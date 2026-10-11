import { describe, expect, it } from "vitest";
import { selectionFieldSchema, selectionLayoutSchema, selectionSharedLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { archiveChoiceColumns, archiveTableFields } from "../../packages/contracts/src/product-archive-table.js";
import { formatSelectionCreatedTime, parseSelectionCreatedTime, selectionCreatedTimeGroupLabel } from "../../packages/contracts/src/selection-created-time.js";
import { createSelectionWorkbook, parseSelectionWorkbook } from "../../apps/web/src/selection-workbook.js";

describe("built-in creation time", () => {
  it("upgrades legacy personal and shared columns without changing layout references", () => {
    const field = { key: "registrationBatch", label: "登记批次", width: 145, type: "date", fallbackType: "text", typePreset: "legacy-date" };
    const layout = selectionLayoutSchema.parse({ columns: [field], fixedColumns: [field.key], columnGroups: [{ id: "time", name: "时间", columnKeys: [field.key] }] });
    expect(layout.columns[0]).toMatchObject({ key: field.key, label: "创建时间", type: "createdTime", width: 145, timeDisplay: "datetime" });
    expect(layout.columns[0].fallbackType).toBeUndefined();
    expect(layout.columns[0].typePreset).toBeUndefined();
    expect(layout.fixedColumns).toEqual([field.key]);
    expect(layout.columnGroups[0].columnKeys).toEqual([field.key]);
    expect(selectionSharedLayoutSchema.parse({ columns: [field] }).columns[0].type).toBe("createdTime");
  });
  it("preserves current time display preferences and unrelated custom fields", () => {
    expect(selectionFieldSchema.parse({ key: "registrationBatch", label: "建档日期", type: "createdTime", timeDisplay: "date" })).toMatchObject({ label: "建档日期", type: "createdTime", timeDisplay: "date" });
    expect(selectionFieldSchema.parse({ key: "custom:batch", label: "登记批次", type: "date", custom: true }).type).toBe("date");
    expect(selectionLayoutSchema.parse({ columns: [] }).columns).toEqual([]);
  });
  it("adds the creation column to a populated archive layout only", () => {
    const canonical = archiveTableFields([]);
    const initial = [{ key: "xutiStyleNo", label: "款号", width: 120 }];
    const fields = archiveChoiceColumns(initial, canonical);
    expect(fields.map(field => field.key)).toEqual(["xutiStyleNo", "registrationBatch"]);
    expect(fields[1]).toMatchObject({ type: "createdTime", label: "创建时间" });
    expect(archiveChoiceColumns([], canonical)).toEqual([]);
    expect(archiveChoiceColumns(fields, canonical)).toEqual(fields);
  });
  it("formats system timestamps in Beijing independently of the legacy batch", () => {
    expect(formatSelectionCreatedTime("2026-10-01T00:01:02Z")).toBe("2026-10-01 08:01:02");
    expect(formatSelectionCreatedTime("2026-09-30T20:01:02Z", "date")).toBe("2026-10-01");
    expect(formatSelectionCreatedTime("invalid")).toBe("");
  });
  it("normalizes edited Beijing dates and rejects empty or invalid calendar values", () => {
    expect(parseSelectionCreatedTime("2026-10-11")).toBe("2026-10-10T16:00:00.000Z");
    expect(parseSelectionCreatedTime("2026-10-11 02:01")).toBe("2026-10-10T18:01:00.000Z");
    expect(parseSelectionCreatedTime("2026-10-11 2:01")).toBe("2026-10-10T18:01:00.000Z");
    expect(parseSelectionCreatedTime("2026-10-11 02:01:02")).toBe("2026-10-10T18:01:02.000Z");
    expect(parseSelectionCreatedTime("2026-10-11T02:01:02+08:00")).toBe("2026-10-10T18:01:02.000Z");
    expect(parseSelectionCreatedTime("2024-02-29 12:30:45")).toBe("2024-02-29T04:30:45.000Z");
    for (const value of ["", null, "2026-02-29", "2026-02-30", "2026-13-01", "2026-10-11 24:01:02", "2026-10-11T02:01:02", "invalid"])
      expect(parseSelectionCreatedTime(value)).toBeNull();
  });
  it("groups the creation instant by Beijing year, calendar quarter, month and day", () => {
    const instant = "2026-09-30T16:00:00Z";
    expect(selectionCreatedTimeGroupLabel(instant, "year")).toBe("2026年");
    expect(selectionCreatedTimeGroupLabel(instant, "quarter")).toBe("2026年第4季度");
    expect(selectionCreatedTimeGroupLabel(instant, "month")).toBe("2026-10");
    expect(selectionCreatedTimeGroupLabel(instant, "day")).toBe("2026-10-01");
    expect(selectionCreatedTimeGroupLabel("2026-09-30T15:59:59Z", "quarter")).toBe("2026年第3季度");
    expect(selectionCreatedTimeGroupLabel("2026-09-30T15:59:59Z", "month")).toBe("2026-09");
    expect(selectionCreatedTimeGroupLabel("2026-09-30T15:59:59Z", "day")).toBe("2026-09-30");
  });
  it("keeps cross-year quarters separate and handles each calendar quarter boundary", () => {
    expect(selectionCreatedTimeGroupLabel("2025-12-31T15:59:59Z", "year")).toBe("2025年");
    expect(selectionCreatedTimeGroupLabel("2025-12-31T16:00:00Z", "year")).toBe("2026年");
    for (const [date, expected] of [["2026-01-01", 1], ["2026-04-01", 2], ["2026-07-01", 3], ["2026-10-01", 4]] as const)
      expect(selectionCreatedTimeGroupLabel(date, "quarter")).toBe(`2026年第${expected}季度`);
    expect(selectionCreatedTimeGroupLabel("2025-10-01", "quarter")).toBe("2025年第4季度");
  });
  it("uses the same buckets for explicit offsets, Beijing drafts and already parsed instants", () => {
    const beijing = "2024/2/29 0:42";
    const utc = "2024-02-28T16:42:00.000Z";
    for (const value of [beijing, "2024-02-29T00:42:00+08:00", utc, new Date(utc), new Date(utc).getTime()])
      expect(selectionCreatedTimeGroupLabel(value, "day")).toBe("2024-02-29");
    expect(selectionCreatedTimeGroupLabel(0, "day")).toBe("1970-01-01");
  });
  it("does not coerce missing, invalid or legacy row values into creation dates", () => {
    for (const value of [undefined, null, "", " ", "invalid", "2026-02-30", "2026-02-30T00:00:00Z", "2026-10-11T02:01:02", new Date(NaN), NaN, Infinity, false, [], { registrationBatch: "2026-10-11" }])
      expect(selectionCreatedTimeGroupLabel(value, "day")).toBe("");
  });
  it("defaults to creation-time ascending while retaining existing explicit organization choices", () => {
    expect(selectionLayoutSchema.parse({ columns: [] })).toMatchObject({ sort: "registrationBatch", direction: "asc", groupBy: "none" });
    for (const sort of ["sortOrder", "updatedAt", "createdAt", "registrationBatch", "supplierCode"])
      expect(selectionLayoutSchema.parse({ columns: [], sort, direction: "desc", groupBy: "supplier" })).toMatchObject({ sort, direction: "desc", groupBy: "supplier" });
    const legacy = selectionLayoutSchema.parse({ columns: [], groupBy: "batch", page: 3 });
    expect(legacy).toMatchObject({ groupBy: "createdTime:day", page: 3 });
    for (const unit of ["year", "quarter", "month", "day"])
      expect(selectionLayoutSchema.parse({ columns: [], groupBy: `createdTime:${unit}` }).groupBy).toBe(`createdTime:${unit}`);
  });
  it("omits the editable batch from the new template and retains legacy import compatibility", async () => {
    const template = await createSelectionWorkbook([], true);
    const headers = template.getWorksheet("选款资料")!.getRow(1).values;
    expect(headers).not.toContain("登记批次");
    expect(headers).toContain("创建时间");
    const legacy = await createSelectionWorkbook([{ xutiStyleNo: "S-1", registrationBatch: "2026-09-28" }]);
    expect(await parseSelectionWorkbook(await legacy.xlsx.writeBuffer() as unknown as ArrayBuffer)).toMatchObject([{ xutiStyleNo: "S-1", registrationBatch: "2026-09-28" }]);
  });
});
