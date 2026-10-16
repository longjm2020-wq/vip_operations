import { describe, expect, it, vi } from "vitest";
import { defaultProtection, legacyAutoHideRegion } from "../../packages/contracts/src/selection-protection.js";
import type { Context } from "../../apps/api/src/core.js";

vi.mock("../../packages/database/src/index.js", async importOriginal => ({ ...await importOriginal<typeof import("../../packages/database/src/index.js")>(), db: {}, one: vi.fn(), rows: vi.fn() }));
import { access, assertFields, assertWrite, fieldVisible, project, rowFields, type Policy } from "../../apps/api/src/modules/style-selections/protection.js";

const actor = { id: "1", username: "admin", displayName: "Admin", permissions: ["selection.read", "selection.manage"], roleCodes: ["SUPER_ADMIN"] };
const context: Context = { actor, requestId: "super-admin" };
const key = "custom:private", orphan = "custom:removed";
const policy = (): Policy => ({
  revision: 1, registeredFieldKeys: [key], privateFieldOwners: { [key]: "2" }, deletedFieldKeys: [key],
  settings: { ...defaultProtection, enabled: true, claimsEnabled: true, autoHide: true, autoHideRegions: [legacyAutoHideRegion], regions: [{ id: "123e4567-e89b-42d3-a456-426614174000", name: "deny", scope: "sheet", rowIds: [], columnKeys: [], users: {}, others: "deny" }] },
});
const row = { id: "58", claimed_by: "2", created_by: "2", material: "棉", extra_fields: { [key]: "Private content", [orphan]: "Legacy content" }, cell_colors: { [orphan]: "RED", "custom:format-only": "BLUE" } };

describe("super-administrator table override", () => {
  it.each([
    ["cellColors", "BLUE", "RED"],
    ["cellAlignments", "right", "left"],
    ["cellVerticalAlignments", "top", "bottom"],
    ["cellTextColors", "#123456", "#654321"],
    ["cellNumberFormats", { type: "currency", decimals: 2 }, { type: "number", decimals: 0 }],
  ])("rejects creation and modification of an unregistered %s entry while allowing unchanged residue", async (container, next, previous) => {
    for (const existing of [undefined, previous]) {
      const before = { ...row, [container as string]: existing === undefined ? {} : { [orphan]: existing } };
      await expect(assertWrite({} as any, context, before, { [container as string]: { [orphan]: next } }, policy())).rejects.toMatchObject({ status: 403, response: { error: { code: "REGION_FORBIDDEN" } } });
    }
    const before = { ...row, [container as string]: { [orphan]: previous } };
    await expect(assertWrite({} as any, context, before, { [container as string]: { [orphan]: previous }, material: "羊毛" }, policy())).resolves.toHaveProperty("cellOwners");
  });

  it.each([{ rowColor: "BLUE" }, { sortOrder: 2 }])("permits row formatting/order without changing retained orphan fields (%j)", async patch => {
    await expect(assertWrite({} as any, context, row, patch, policy())).resolves.toHaveProperty("cellOwners");
  });

  it("permits whole-row operations despite protected, claimed, private and orphan field residue", () => {
    const p = policy();
    for (const field of rowFields(row)) expect(access(p, actor, row, field)).toBe("edit");
    expect(() => assertFields(p, context, row, rowFields(row))).not.toThrow();
    expect(fieldVisible(p, actor, key)).toBe(true);
    expect(fieldVisible(p, actor, orphan)).toBe(false);
    const ordinary = { ...actor, roleCodes: [] };
    expect(access(p, ordinary, row, key)).toBe("deny");
    expect(() => assertFields(p, { ...context, actor: ordinary }, row, rowFields(row))).toThrow();
  });

  it("projects registered private data to the super-administrator without resurrecting orphan definitions", () => {
    const result = project(policy(), actor, row);
    expect(result.extraFields[key]).toBe("Private content");
    expect(result.extraFields).not.toHaveProperty(orphan);
    expect(result.cellAccess[key]).toBe("edit");
    expect(result.hiddenCells).toEqual([]);
    expect(result.defaultCellAccess).toBe("edit");
  });

  it("retains the transfer workflow lock for super-administrator read and write paths", () => {
    const locked = { ...row, migration_locked: true };
    expect(access(policy(), actor, locked, key)).toBe("read");
    expect(() => assertFields(policy(), context, locked, rowFields(locked))).toThrowError(expect.objectContaining({ status: 409, response: { error: { code: "MIGRATION_LOCKED", message: expect.any(String), details: undefined } } }));
    expect(() => assertFields(policy(), context, locked, rowFields(locked), false)).not.toThrow();
  });

  it("continues validating unknown writes and computed values instead of treating permissions as business overrides", async () => {
    await expect(assertWrite({} as any, context, row, { extraFields: { [orphan]: "Changed" } }, policy())).rejects.toMatchObject({ status: 403, response: { error: { code: "REGION_FORBIDDEN" } } });
    await expect(assertWrite({} as any, context, row, { extraFields: { [key]: "Changed" } }, { ...policy(), computedFieldKeys: [key] })).rejects.toMatchObject({ status: 400, response: { error: { code: "VALIDATION_ERROR" } } });
    await expect(assertWrite({} as any, context, row, { material: "Too long" }, { ...policy(), textFields: [{ key: "material", label: "材质", width: 100, type: "text", textConfig: { countMode: "characters", maxLength: 2 } }] })).rejects.toMatchObject({ status: 400, response: { error: { code: "VALIDATION_ERROR" } } });
  });
});
