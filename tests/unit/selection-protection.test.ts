import { describe, expect, it } from "vitest";
import {
  defaultProtection,
  selectionCellAccess,
  selectionProtectionSchema,
  normalizeSelectionProtection,
  legacyAutoHideRegion,
  type ProtectionRegion,
  type SelectionProtection,
} from "../../packages/contracts/src/selection-protection.js";
import {
  selectionDelta,
  mergeSelectionSave,
} from "../../apps/web/src/selection-autosave.js";
import { clearSelectionCells } from "../../apps/web/src/selection-filters.js";
const actor = {
  id: "2",
  permissions: ["selection.read", "selection.manage"],
  roleCodes: ["BUYER"],
};
const row = { id: "10", createdBy: "1", cellOwners: { material: "2" } };
const rule = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  name: "价格保护",
  scope: "cells" as const,
  rowIds: ["10"],
  columnKeys: ["supplyPriceExclTax"],
  users: { "2": "edit" as const },
  others: "deny" as const,
};
const sheetReadRule: ProtectionRegion = {
  ...rule,
  id: "123e4567-e89b-42d3-a456-426614174002",
  name: "整表默认只读",
  scope: "sheet",
  rowIds: [],
  columnKeys: [],
  users: { "1": "edit" },
  others: "read",
};
describe("selection protection policy", () => {
  it("limits grants to module rights and uses the strongest overlapping region", () => {
    const settings: SelectionProtection = {
      ...defaultProtection,
      enabled: true,
      regions: [
        rule,
        {
          ...rule,
          id: "123e4567-e89b-42d3-a456-426614174001",
          scope: "columns",
          users: { "2": "read" },
          others: "read",
        },
      ],
    };
    expect(
      selectionCellAccess(settings, actor, row, "supplyPriceExclTax"),
    ).toBe("read");
    expect(
      selectionCellAccess(
        { ...settings, regions: [rule] },
        { ...actor, permissions: ["selection.read"] },
        row,
        "supplyPriceExclTax",
      ),
    ).toBe("read");
    expect(
      selectionCellAccess(
        settings,
        { ...actor, id: "3" },
        row,
        "supplyPriceExclTax",
      ),
    ).toBe("deny");
    expect(
      selectionCellAccess(
        settings,
        { ...actor, roleCodes: ["ADMIN"] },
        row,
        "supplyPriceExclTax",
      ),
    ).toBe("edit");
  });
  it.each(["cells", "rows", "columns"] as const)(
    "allows a named %s editor within default-read sheets regardless of region order",
    (scope) => {
      const local: ProtectionRegion = { ...rule, scope };
      const sheets: ProtectionRegion[] = [
        sheetReadRule,
        { ...sheetReadRule, id: "123e4567-e89b-42d3-a456-426614174003" },
      ];
      for (const regions of [[...sheets, local], [local, ...sheets]]) {
        const settings: SelectionProtection = { ...defaultProtection, enabled: true, regions };
        expect(selectionCellAccess(settings, actor, row, "supplyPriceExclTax")).toBe("edit");
        const outsideRow = scope === "columns" ? row : { ...row, id: "11" };
        const outsideKey = scope === "columns" ? "material" : "supplyPriceExclTax";
        expect(selectionCellAccess(settings, actor, outsideRow, outsideKey)).toBe("read");
        if (scope === "cells")
          expect(selectionCellAccess(settings, actor, row, "material")).toBe("read");
        expect(selectionCellAccess(settings, { ...actor, id: "3" }, row, "supplyPriceExclTax")).toBe("deny");
      }
    },
  );
  it("keeps sheet restrictions explicitly set for the user and every deny restriction", () => {
    const settings: SelectionProtection = { ...defaultProtection, enabled: true, regions: [sheetReadRule, rule] };
    for (const access of ["read", "deny"] as const) {
      expect(selectionCellAccess({ ...settings, regions: [
        { ...sheetReadRule, users: { "2": access } }, rule,
      ] }, actor, row, "supplyPriceExclTax")).toBe(access);
    }
    expect(selectionCellAccess({ ...settings, regions: [
      { ...sheetReadRule, others: "deny" }, rule,
    ] }, actor, row, "supplyPriceExclTax")).toBe("deny");
    expect(selectionCellAccess({ ...settings, regions: [
      sheetReadRule, rule,
      { ...rule, id: "123e4567-e89b-42d3-a456-426614174004", scope: "rows", users: {}, others: "deny" },
    ] }, actor, row, "supplyPriceExclTax")).toBe("deny");
  });
  it("keeps local overlapping read restrictions and requires a named local edit grant", () => {
    const settings: SelectionProtection = { ...defaultProtection, enabled: true, regions: [sheetReadRule, rule] };
    const userRestrictions: ProtectionRegion["users"][] = [{ "2": "read" }, {}];
    for (const users of userRestrictions) {
      expect(selectionCellAccess({ ...settings, regions: [
        sheetReadRule, rule,
        { ...rule, id: "123e4567-e89b-42d3-a456-426614174004", scope: "columns", users, others: "read" },
      ] }, actor, row, "supplyPriceExclTax")).toBe("read");
    }
    expect(selectionCellAccess({ ...settings, regions: [
      sheetReadRule, { ...rule, users: {}, others: "edit" },
    ] }, actor, row, "supplyPriceExclTax")).toBe("read");
  });
  it("caps local exceptions by module rights, automatic hiding and another user's claim", () => {
    const settings: SelectionProtection = { ...defaultProtection, enabled: true, regions: [sheetReadRule, rule] };
    expect(selectionCellAccess(settings, { ...actor, permissions: ["selection.read"] }, row, "supplyPriceExclTax")).toBe("read");
    expect(selectionCellAccess(settings, { ...actor, permissions: ["selection.manage"] }, row, "supplyPriceExclTax")).toBe("deny");
    expect(selectionCellAccess({ ...settings, claimsEnabled: true }, actor, { ...row, claimedBy: "3" }, "supplyPriceExclTax")).toBe("read");
    expect(selectionCellAccess({ ...settings, claimsEnabled: true }, actor, { ...row, claimedBy: "2" }, "supplyPriceExclTax")).toBe("edit");
    const hiddenSettings = { ...settings, autoHide: true, autoHideRegions: [legacyAutoHideRegion] };
    expect(selectionCellAccess(hiddenSettings, actor, row, "supplyPriceExclTax")).toBe("deny");
    expect(selectionCellAccess(hiddenSettings, actor, row, "supplyPriceExclTax", false)).toBe("edit");
    expect(selectionCellAccess({ ...hiddenSettings, hiddenReaders: [actor.id] }, actor, row, "supplyPriceExclTax")).toBe("edit");
  });
  it("follows stable IDs, including future rows under column and sheet rules", () => {
    const settings = {
      ...defaultProtection,
      enabled: true,
      regions: [{ ...rule, scope: "columns" as const }],
    };
    expect(
      selectionCellAccess(
        settings,
        { ...actor, id: "3" },
        { ...row, id: "999" },
        "supplyPriceExclTax",
      ),
    ).toBe("deny");
    expect(
      selectionCellAccess(
        { ...settings, regions: [rule] },
        { ...actor, id: "3" },
        { ...row, id: "999" },
        "supplyPriceExclTax",
      ),
    ).toBe("edit");
  });
  it("hides filled values while leaving empty cells fillable, with author / filler / designated-reader visibility", () => {
    const settings = {
      ...defaultProtection,
      autoHide: true,
      autoHideRegions: [{ ...legacyAutoHideRegion }],
      hiddenReaders: ["4"],
    };
    expect(selectionCellAccess(settings, actor, row, "material")).toBe("edit");
    expect(selectionCellAccess(settings, actor, row, "supplierCode")).toBe(
      "deny",
    );
    expect(
      selectionCellAccess(settings, actor, row, "supplierCode", false),
    ).toBe("edit");
    expect(
      selectionCellAccess(settings, { ...actor, id: "1" }, row, "supplierCode"),
    ).toBe("edit");
    expect(
      selectionCellAccess(settings, { ...actor, id: "4" }, row, "supplierCode"),
    ).toBe("edit");
    expect(
      selectionCellAccess(
        {
          ...settings,
          enabled: true,
          regions: [
            { ...rule, columnKeys: ["material"], users: {}, others: "deny" },
          ],
        },
        actor,
        row,
        "material",
      ),
    ).toBe("deny");
  });
  it("automatically hides only selected cells; outside rows and fields retain their existing access", () => {
    const area = { id: rule.id, name: "supplier area", scope: "cells" as const, rowIds: ["10"], columnKeys: ["supplierCode"] };
    const settings: SelectionProtection = { ...defaultProtection, autoHide: true, autoHideRegions: [area] };
    expect(selectionCellAccess(settings, actor, row, "supplierCode")).toBe("deny");
    expect(selectionCellAccess(settings, actor, row, "color")).toBe("edit");
    expect(selectionCellAccess(settings, actor, { ...row, id: "11" }, "supplierCode")).toBe("edit");
    expect(selectionCellAccess(settings, actor, row, "supplierCode", false)).toBe("edit");
    expect(selectionCellAccess({ ...settings, autoHide: false }, actor, row, "supplierCode")).toBe("edit");
  });
  it("auto-hide rows include new fields, columns include new rows, and sheet scope is explicit", () => {
    const settings: SelectionProtection = { ...defaultProtection, autoHide: true, autoHideRegions: [{ ...legacyAutoHideRegion, scope: "rows", rowIds: ["10"] }] };
    expect(selectionCellAccess(settings, actor, row, "custom:new")).toBe("deny");
    expect(selectionCellAccess(settings, actor, { ...row, id: "11" }, "supplierCode")).toBe("edit");
    const columns: SelectionProtection = { ...settings, autoHideRegions: [{ ...legacyAutoHideRegion, scope: "columns", columnKeys: ["supplierCode"] }] };
    expect(selectionCellAccess(columns, actor, { ...row, id: "999" }, "supplierCode")).toBe("deny");
    expect(selectionCellAccess(columns, actor, row, "color")).toBe("edit");
    expect(selectionCellAccess({ ...settings, autoHideRegions: [legacyAutoHideRegion] }, actor, { ...row, id: "999" }, "custom:new")).toBe("deny");
  });
  it("requires an explicit nonempty valid auto-hide area list and distinct identities", () => {
    const settings = { ...defaultProtection, autoHide: true };
    expect(selectionProtectionSchema.safeParse(settings).success).toBe(false);
    expect(selectionCellAccess(settings, actor, row, "supplierCode")).toBe("edit");
    expect(selectionProtectionSchema.safeParse({ ...settings, autoHideRegions: [legacyAutoHideRegion] }).success).toBe(true);
    expect(selectionProtectionSchema.safeParse({ ...settings, autoHideRegions: [{ ...legacyAutoHideRegion, scope: "cells", rowIds: ["10"] }] }).success).toBe(false);
    expect(selectionProtectionSchema.safeParse({ ...settings, autoHideRegions: [{ ...legacyAutoHideRegion, scope: "columns", columnKeys: ["password"] }] }).success).toBe(false);
    expect(selectionProtectionSchema.safeParse({ ...settings, autoHideRegions: [legacyAutoHideRegion, legacyAutoHideRegion] }).success).toBe(false);
  });
  it("normalizes legacy enabled policies to a visible sheet rule without enabling disabled policies", () => {
    const { autoHideRegions: _areas, ...legacy } = defaultProtection;
    const enabled = normalizeSelectionProtection({ ...legacy, autoHide: true });
    expect(enabled.autoHideRegions).toEqual([legacyAutoHideRegion]);
    expect(selectionCellAccess(enabled, actor, row, "supplierCode")).toBe("deny");
    expect(normalizeSelectionProtection(legacy)).toEqual(defaultProtection);
    expect(normalizeSelectionProtection({ ...defaultProtection, autoHide: true }).autoHideRegions).toEqual([]);
    expect(normalizeSelectionProtection(null)).toEqual(defaultProtection);
  });
  it("locks a claimed row for another editor but leaves readable values visible", () => {
    expect(
      selectionCellAccess(
        { ...defaultProtection, claimsEnabled: true },
        actor,
        { ...row, claimedBy: "3" },
        "material",
      ),
    ).toBe("read");
    expect(
      selectionCellAccess(
        { ...defaultProtection, claimsEnabled: true },
        actor,
        { ...row, claimedBy: "2" },
        "material",
      ),
    ).toBe("edit");
  });
  it("rejects empty regions, arbitrary fields and duplicate region identities", () => {
    expect(
      selectionProtectionSchema.safeParse({
        ...defaultProtection,
        regions: [{ ...rule, rowIds: [] }],
      }).success,
    ).toBe(false);
    expect(
      selectionProtectionSchema.safeParse({
        ...defaultProtection,
        regions: [{ ...rule, columnKeys: ["password"] }],
      }).success,
    ).toBe(false);
    expect(
      selectionProtectionSchema.safeParse({
        ...defaultProtection,
        regions: [rule, rule],
      }).success,
    ).toBe(false);
  });
  it("sends only changed JSON entries and cannot restore data hidden by a concurrent save", () => {
    expect(
      selectionDelta(
        {
          material: "new",
          extraFields: { "custom:a": "", "custom:b": "new" },
          cellColors: {},
          expectedUpdatedAt: "old",
        },
        {
          material: "old",
          extraFields: { "custom:a": "", "custom:b": "old" },
          cellColors: { material: "GREEN" },
        },
      ),
    ).toEqual({
      material: "new",
      extraFields: { "custom:b": "new" },
      cellColors: { material: null },
      expectedUpdatedAt: "old",
    });
    const sent = {
        _key: "10",
        material: "old",
        extraFields: { "custom:a": "old" },
      },
      current = {
        ...sent,
        material: "SECRET",
        extraFields: { "custom:a": "SECRET" },
      };
    const saved = {
      ...sent,
      material: null,
      extraFields: { "custom:a": "" },
      cellAccess: { material: "deny", "custom:a": "deny" },
      hiddenCells: ["material", "custom:a"],
    };
    expect(
      JSON.stringify(mergeSelectionSave(current, sent, saved)),
    ).not.toContain("SECRET");
  });
  it("Delete skips protected cells and cannot clear image labels through a protected colour side effect", () => {
    const row = {
      _key: "10",
      material: "secret",
      supplierCode: "okay",
      color: "白",
      images: [{ color: "白" }],
      cellAccess: {
        material: "deny",
        supplierCode: "edit",
        color: "edit",
        images: "read",
      },
    };
    expect(
      clearSelectionCells(
        [row],
        new Set(["10::material", "10::supplierCode", "10::color"]),
      )[0],
    ).toMatchObject({
      material: "secret",
      supplierCode: null,
      color: "白",
      images: [{ color: "白" }],
    });
  });
});
