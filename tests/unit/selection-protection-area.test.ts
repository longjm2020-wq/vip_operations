import { describe, expect, it } from "vitest";
import { normalizeProtectionArea, selectionProtectionArea } from "../../apps/web/src/selection-protection-area.js";
import { defaultProtection, selectionCellAccess, type ProtectionRegion } from "../../packages/contracts/src/selection-protection.js";

const rows = [{ _key: "row-a", id: "10" }, { _key: "row-b", id: "20" }];
const columns = [{ key: "material" }, { key: "supplyPriceExclTax" }];
const base = { rows, columns, selectedCells: new Set<string>(), selectedRows: [], selectedColumnKeys: [], emptyScope: "cells" as const };
const actor = { id: "2", permissions: ["selection.read", "selection.manage"] };
const access = (area: Pick<ProtectionRegion, "scope" | "rowIds" | "columnKeys">, rowId: string, key: string) => selectionCellAccess({
  ...defaultProtection, enabled: true,
  regions: [{ ...area, id: "123e4567-e89b-42d3-a456-426614174000", name: "受保护资料", users: {}, others: "deny" }],
}, actor, { id: rowId }, key);

describe("protection selection scope and future content", () => {
  it("protects future and off-page rows when a column header is selected", () => {
    const area = selectionProtectionArea({ ...base, selectedColumnKeys: ["material"], selectedCells: new Set(["row-a::material"]) });
    expect(area).toEqual({ scope: "columns", rowIds: [], columnKeys: ["material"] });
    expect(access(area, "20", "material")).toBe("deny");
    expect(access(area, "999", "material")).toBe("deny");
    expect(access(area, "999", "custom:new")).toBe("edit");
  });

  it("keeps the column intent on an empty table without turning it into whole-sheet protection", () => {
    const area = selectionProtectionArea({ ...base, rows: [], selectedColumnKeys: ["material"] });
    expect(access(area, "999", "material")).toBe("deny");
    expect(access(area, "999", "supplyPriceExclTax")).toBe("edit");
  });

  it("extends checked rows to new fields while ignoring the previous cell selection", () => {
    const area = selectionProtectionArea({ ...base, selectedRows: ["row-b"], selectedCells: new Set(["row-a::material"]) });
    expect(area).toEqual({ scope: "rows", rowIds: ["20"], columnKeys: [] });
    expect(access(area, "20", "custom:new")).toBe("deny");
    expect(access(area, "10", "material")).toBe("edit");
    expect(access(area, "999", "custom:new")).toBe("edit");
  });

  it("does not expand a cell selection even if it spans all visible rows and fields", () => {
    const area = selectionProtectionArea({ ...base, selectedCells: new Set(rows.flatMap(row => columns.map(column => `${row._key}::${column.key}`))) });
    expect(area.scope).toBe("cells");
    expect(access(area, "10", "material")).toBe("deny");
    expect(access(area, "10", "custom:new")).toBe("edit");
    expect(access(area, "999", "material")).toBe("edit");
  });

  it("requires persisted row identities only for bounded rows and cells", () => {
    const unsaved = { ...base, rows: [...rows, { _key: "draft" }], selectedCells: new Set(["draft::material"]) };
    expect(() => selectionProtectionArea(unsaved)).toThrow("请先保存选中行");
    expect(() => selectionProtectionArea({ ...unsaved, selectedRows: ["draft"] })).toThrow("请先保存选中行");
    expect(selectionProtectionArea({ ...unsaved, selectedColumnKeys: ["material"] }).rowIds).toEqual([]);
  });

  it("rejects stale fields instead of widening their scope", () => {
    expect(() => selectionProtectionArea({ ...base, selectedColumnKeys: ["custom:removed"] })).toThrow("选中字段已变化");
    expect(() => selectionProtectionArea({ ...base, selectedCells: new Set(["row-a::custom:removed"]) })).toThrow("选中字段已变化");
  });

  it("preserves the explicit empty-selection defaults for protection and hiding", () => {
    expect(selectionProtectionArea(base)).toEqual({ scope: "cells", rowIds: [], columnKeys: [] });
    const sheet = selectionProtectionArea({ ...base, emptyScope: "sheet" });
    expect(access(sheet, "999", "custom:new")).toBe("deny");
  });

  it("removes unused dimensions on scope changes without changing existing cell regions or grants", () => {
    const original: ProtectionRegion = { id: "123e4567-e89b-42d3-a456-426614174000", name: "原单元格区域", scope: "cells", rowIds: ["10"], columnKeys: ["material"], users: { "2": "read" }, others: "deny" };
    expect(normalizeProtectionArea(original)).toEqual(original);
    const column = normalizeProtectionArea({ ...original, scope: "columns" });
    expect(column.rowIds).toEqual([]);
    expect(column.users).toEqual(original.users);
    expect(normalizeProtectionArea({ ...original, scope: "rows" }).columnKeys).toEqual([]);
    const sheet = normalizeProtectionArea({ ...original, scope: "sheet" });
    expect([sheet.rowIds, sheet.columnKeys]).toEqual([[], []]);
    expect(original.rowIds).toEqual(["10"]);
  });
});
