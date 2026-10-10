import { describe, expect, it } from "vitest";
import { retainSelectionResults } from "../../apps/web/src/selection-retained-results.js";

type Row = { _key: string; value: string; cellAccess?: Record<string, string>; policyRevision?: number };
const label = (row: Row) => row.cellAccess?.value === "deny" ? "受保护内容" : row.value || "未填写";
const readable = (row: Row) => row.cellAccess?.value !== "deny";
const empty = (rows: Row[]) => rows.filter(row => !row.value && readable(row));

describe("manual filter result retention", () => {
  it("retains multiple filled rows in their original positions, using current data until same-condition reapply", () => {
    const rows: Row[] = [{ _key: "a", value: "" }, { _key: "b", value: "" }, { _key: "c", value: "filled" }];
    const first = retainSelectionResults(null, "empty:1", rows, empty(rows), label, readable)!;
    const changed = rows.map(row => ({ ...row, value: row._key === "c" ? row.value : "已补填" }));
    const held = retainSelectionResults(first, "empty:1", changed, empty(changed), label, readable)!;
    expect(held.entries.map(entry => entry.key)).toEqual(["a", "b"]);
    expect(held).toBe(first);
    // The cache contains identity and display-group metadata, not copies of old row values.
    expect(held.entries[0]).not.toHaveProperty("value");
    expect(retainSelectionResults(held, "empty:2", changed, empty(changed), label, readable)!.entries).toEqual([]);
  });

  it("appends newly matching records without replacing filled members, and drops deleted records", () => {
    const rows: Row[] = [{ _key: "a", value: "" }];
    const first = retainSelectionResults(null, "empty", rows, rows, label, readable)!;
    const updated = [{ _key: "a", value: "filled" }, { _key: "b", value: "" }];
    const next = retainSelectionResults(first, "empty", updated, empty(updated), label, readable)!;
    expect(next.entries.map(entry => entry.key)).toEqual(["a", "b"]);
    const deleted = updated.slice(1);
    expect(retainSelectionResults(next, "empty", deleted, empty(deleted), label, readable)!.entries.map(entry => entry.key)).toEqual(["b"]);
  });

  it("never retains inaccessible members and replaces group labels when access changes", () => {
    const rows: Row[] = [{ _key: "a", value: "私密组", cellAccess: { value: "edit" } }];
    const first = retainSelectionResults(null, "scope", rows, rows, label, readable)!;
    const read = [{ ...rows[0], value: "新组", cellAccess: { value: "read" } }];
    const next = retainSelectionResults(first, "scope", read, [], label, readable)!;
    expect(next.entries[0].groupLabel).toBe("新组");
    expect(next.entries[0].access).not.toBe(first.entries[0].access);
    const denied = [{ ...read[0], value: "", cellAccess: { value: "deny" } }];
    const removed = retainSelectionResults(next, "scope", denied, denied, label, readable)!;
    expect(removed.entries).toEqual([]);
    expect(retainSelectionResults(removed, "scope", denied, denied, label, readable)).toBe(removed);
  });

  it("recomputes group metadata after policy updates and releases results without a filter", () => {
    const rows: Row[] = [{ _key: "a", value: "原始组", policyRevision: 1 }];
    const first = retainSelectionResults(null, "scope", rows, rows, label, readable)!;
    const projected = [{ ...rows[0], value: "", policyRevision: 2 }];
    expect(retainSelectionResults(first, "scope", projected, [], label, readable)!.entries[0].groupLabel).toBe("未填写");
    expect(retainSelectionResults(first, null, rows, rows, label, readable)).toBeNull();
  });
});
