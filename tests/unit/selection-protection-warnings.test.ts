import { describe, expect, it } from "vitest";
import {
  defaultProtection,
  type ProtectionRegion,
} from "../../packages/contracts/src/selection-protection.js";
import {
  protectionEditWarnings,
  protectionRegionsOverlap,
} from "../../apps/web/src/selection-protection-warnings.js";

const local: ProtectionRegion = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  name: "尺码表",
  scope: "cells",
  rowIds: ["51"],
  columnKeys: ["custom:size"],
  users: { "2": "edit" },
  others: "read",
};
const sheet: ProtectionRegion = {
  ...local,
  id: "123e4567-e89b-42d3-a456-426614174001",
  name: "整表只读",
  scope: "sheet",
  rowIds: [],
  columnKeys: [],
  users: {},
};
const editable = [{ id: "2", canEdit: true, canManage: false }];

describe("protection edit grant explanations", () => {
  it("does not warn for the allowed local exception to whole sheet default read", () => {
    expect(protectionEditWarnings(local, {
      ...defaultProtection, enabled: true, regions: [sheet, local],
    }, editable)).toEqual([]);
  });

  it("identifies explicit whole sheet restrictions and every deny as remaining blockers", () => {
    for (const blocker of [
      { ...sheet, users: { "2": "read" as const } },
      { ...sheet, users: { "2": "deny" as const } },
      { ...sheet, others: "deny" as const },
    ]) {
      expect(protectionEditWarnings(local, {
        ...defaultProtection, enabled: true, regions: [local, blocker],
      }, editable)).toEqual([{ userId: "2", overlappingRegions: ["整表只读"] }]);
    }
  });

  it("names partially overlapping local restrictions without treating disjoint cells as blocked", () => {
    const blocker = { ...local, id: sheet.id, name: "列保护", scope: "columns" as const, users: {}, others: "read" as const };
    const larger = { ...local, rowIds: ["51", "52"], columnKeys: ["custom:size", "material"] };
    expect(protectionEditWarnings(larger, {
      ...defaultProtection, regions: [larger, blocker],
    }, editable)[0].overlappingRegions).toEqual(["列保护"]);
    expect(protectionEditWarnings({ ...local, columnKeys: ["material"] }, {
      ...defaultProtection, regions: [blocker],
    }, editable)).toEqual([]);
    expect(protectionRegionsOverlap(local, { ...local, id: sheet.id, rowIds: ["52"] })).toBe(false);
    expect(protectionRegionsOverlap(local, { ...local, id: sheet.id, scope: "rows", columnKeys: [] })).toBe(true);
  });

  it("explains the actual module cap while retaining grants for a later role change", () => {
    expect(protectionEditWarnings(local, {
      ...defaultProtection, regions: [local],
    }, [{ id: "2", canEdit: false, editBlockReason: "没有商品档案编辑权限" }])).toEqual([
      { userId: "2", moduleReason: "没有商品档案编辑权限", overlappingRegions: [] },
    ]);
    expect(local.users).toEqual({ "2": "edit" });
    expect(protectionEditWarnings(local, defaultProtection, [{ id: "2" }])).toEqual([]);
  });

  it("respects protection manager bypass without inventing content editing rights", () => {
    const denied = { ...sheet, others: "deny" as const };
    expect(protectionEditWarnings(local, {
      ...defaultProtection, regions: [local, denied],
    }, [{ id: "2", canEdit: true, canManage: true }])).toEqual([]);
    expect(protectionEditWarnings(local, {
      ...defaultProtection, regions: [local, denied],
    }, [{ id: "2", canEdit: false, canManage: true }])).toEqual([
      { userId: "2", moduleReason: "没有本表内容编辑权限", overlappingRegions: [] },
    ]);
  });
});
