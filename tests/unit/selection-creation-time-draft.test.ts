import { describe, expect, it } from "vitest";
import { selectionCreationTimeComparable, selectionCreationTimeError, selectionCreationTimeForSave, selectionCreationTimeValue, withSelectionCreationTime } from "../../apps/web/src/selection-creation-time.js";
import { selectionSystemValue } from "../../apps/web/src/selection-system-fields.js";
import { mergeSelectionRemote, mergeSelectionSave } from "../../apps/web/src/selection-autosave.js";

const before = { _key: "row", id: "1", createdAt: "2026-10-01T00:01:02Z", updatedAt: "old", version: 1, material: "棉", registrationBatch: "2026-09-28" };

describe("editable built-in creation time", () => {
  it("keeps partial input instead of replacing it with a formatted date", () => {
    const draft = withSelectionCreationTime(before, "2026-10-0");
    expect(draft.createdAt).toBe(before.createdAt);
    expect(selectionCreationTimeValue(draft)).toBe("2026-10-0");
    expect(selectionCreationTimeError(draft)).toContain("有效的北京时间");
    expect(selectionCreationTimeForSave(draft)).toBeUndefined();
    expect(selectionCreationTimeComparable(draft)).not.toBe(selectionCreationTimeComparable(before));
    expect(draft.registrationBatch).toBe(before.registrationBatch);
  });

  it.each([
    ["2026-10-02", "2026-10-01T16:00:00.000Z"],
    ["2026-10-02 10:30", "2026-10-02T02:30:00.000Z"],
    ["2026-10-02 10:30:45", "2026-10-02T02:30:45.000Z"],
  ])("saves %s as its exact Beijing instant", (input, expected) => {
    const draft = withSelectionCreationTime(before, input);
    expect(selectionCreationTimeError(draft)).toBeUndefined();
    expect(selectionCreationTimeForSave(draft)).toBe(expected);
    expect(draft.createdAt).toBe(expected);
    expect(selectionCreationTimeValue(draft, "date")).toBe(input);
  });

  it.each(["", " ", "2026-02-29", "2026-10-11 24:00", "2026-10-11 13:61"])("retains invalid input %j and prevents clearing or rollover", input => {
    const draft = withSelectionCreationTime(before, input);
    expect(selectionCreationTimeValue(draft)).toBe(input);
    expect(selectionCreationTimeError(draft)).toBeTruthy();
    expect(selectionCreationTimeForSave(draft)).toBeUndefined();
    expect(draft.createdAt).toBe(before.createdAt);
  });

  it("only uses the raw draft for the built-in system column", () => {
    const draft = withSelectionCreationTime(before, "2026-10-");
    expect(selectionSystemValue(draft, { key: "registrationBatch", label: "创建时间", width: 160, type: "createdTime" })).toBe("2026-10-");
    expect(selectionSystemValue(draft, { key: "custom:time", label: "时间", width: 160, type: "createdTime", custom: true })).toBe("2026-10-01 08:01:02");
  });

  it("treats equivalent ISO and displayed timestamp spellings as the same saved value", () => {
    expect(selectionCreationTimeComparable(withSelectionCreationTime(before, "2026-10-01 08:01:02"))).toBe(selectionCreationTimeComparable(before));
  });

  it.each(["2026-10-02 10:30:45", "2026-10-0", ""])("retains newer input %j during a previous save", input => {
    const sent = withSelectionCreationTime(before, "2026-10-02 10:30");
    const current = withSelectionCreationTime(sent, input);
    const saved = { ...sent, updatedAt: "saved", version: 2 };
    const result = mergeSelectionSave(current, sent, saved);
    expect(result.creationTimeDraft).toBe(input);
    expect(result.createdAt).toBe(current.createdAt);
    expect(result.updatedAt).toBe("saved");
    expect(result.registrationBatch).toBe(before.registrationBatch);
  });

  it("clears a submitted draft after success and adopts the normalized server time", () => {
    const sent = withSelectionCreationTime(before, "2026-10-02");
    const result = mergeSelectionSave(sent, sent, { ...sent, createdAt: "2026-10-01T16:00:00.000Z", updatedAt: "saved", version: 2 });
    expect(result).not.toHaveProperty("creationTimeDraft");
    expect(selectionCreationTimeValue(result)).toBe("2026-10-02 00:00:00");
  });

  it("retains local time with a disjoint remote edit and detects time collisions on the visible column", () => {
    const current = withSelectionCreationTime(before, "2026-10-02");
    const incoming = { ...before, material: "羊毛", updatedAt: "remote", version: 2 };
    const merged = mergeSelectionRemote(current, before, incoming);
    expect(merged.conflicts).toEqual([]);
    expect(merged.row).toMatchObject({ creationTimeDraft: "2026-10-02", createdAt: current.createdAt, material: "羊毛", updatedAt: "remote", version: 2 });
    const collision = mergeSelectionRemote(current, before, { ...incoming, createdAt: "2026-10-03T00:00:00.000Z" });
    expect(collision.conflicts).toEqual(["registrationBatch"]);
    expect(collision.row).toMatchObject({ createdAt: current.createdAt, creationTimeDraft: "2026-10-02", updatedAt: "old", version: 1 });
  });

  it.each([
    { cellAccess: { registrationBatch: "read" }, defaultCellAccess: "edit" },
    { cellAccess: {}, defaultCellAccess: "read" },
    { cellAccess: { registrationBatch: "edit" }, defaultCellAccess: "edit", migrationLocked: true },
  ])("drops a time draft when its edit permission is revoked", access => {
    const sent = withSelectionCreationTime(before, "2026-10-02");
    const current = withSelectionCreationTime(sent, "2026-10-03");
    const incoming = { ...before, ...access, updatedAt: "remote", version: 2 };
    expect(mergeSelectionSave(current, sent, incoming)).not.toHaveProperty("creationTimeDraft");
    const merged = mergeSelectionRemote(current, before, incoming);
    expect(merged.row).not.toHaveProperty("creationTimeDraft");
    expect(merged.row.createdAt).toBe(incoming.createdAt);
    expect(merged.conflicts).toEqual([]);
  });
});
