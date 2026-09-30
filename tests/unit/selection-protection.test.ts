import { describe, expect, it } from "vitest";
import {
  defaultProtection,
  selectionCellAccess,
  selectionProtectionSchema,
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
