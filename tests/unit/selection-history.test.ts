import { describe, expect, it } from "vitest";
import { applySelectionHistoryChange, createSelectionHistoryChange, mergeSelectionHistoryChanges, SelectionHistory, SelectionOperationHistory } from "../../apps/web/src/selection-history.js";
import { selectionCreationTimeForSave, withSelectionCreationTime } from "../../apps/web/src/selection-creation-time.js";

type Row = Record<string, any>;
const row = (value: unknown): Row => ({ _key: "one", id: "1", material: value });
const change = (before: Row[], after: Row[], fields = ["material"]) => createSelectionHistoryChange(before, after, fields)!;
const applied = (result: ReturnType<typeof applySelectionHistoryChange<Row>>) => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.rows;
};

describe("table session history", () => {
  it("keeps ten operations, restores them in order, then redoes without losing a step", () => {
    const history = new SelectionHistory(100);
    let rows = [row(0)];
    for (let value = 1; value <= 12; value++) {
      const next = [row(value)];
      history.record(change(rows, next));
      rows = next;
    }
    expect(history.undoCount).toBe(10);
    for (let expected = 11; expected >= 2; expected--) {
      rows = applied(history.undo(rows));
      expect(rows[0].material).toBe(expected);
    }
    expect(history.undo(rows)).toEqual({ ok: false, reason: "empty" });
    expect(history.redoCount).toBe(10);
    for (let expected = 3; expected <= 12; expected++) {
      rows = applied(history.redo(rows));
      expect(rows[0].material).toBe(expected);
    }
    expect(history.redo(rows)).toEqual({ ok: false, reason: "empty" });
  });

  it("clears the redo branch only after another actual edit and clears all retained values on reset", () => {
    const history = new SelectionHistory();
    history.record(change([row("A")], [row("B")]));
    history.record(change([row("B")], [row("C")]));
    const rows = applied(history.undo([row("C")]));
    history.record(createSelectionHistoryChange(rows, rows, ["material"]));
    expect(history.canRedo).toBe(true);
    history.record(change(rows, [row("D")]));
    expect(history.canRedo).toBe(false);
    expect(applied(history.undo([row("D")]))[0].material).toBe("B");
    history.clear();
    expect([history.canUndo, history.canRedo, history.undoCount, history.redoCount]).toEqual([false, false, 0, 0]);
  });

  it("groups continuous typing while preserving its initial value and keeps batch operations separate", () => {
    const history = new SelectionHistory();
    history.record(change([row("")], [row("棉")] ), "one:material", 0);
    history.record(change([row("棉")], [row("棉麻")] ), "one:material", 400);
    history.record(change([row("棉麻")], [row("棉麻混纺")] ), "one:material", 900);
    expect(history.undoCount).toBe(1);
    expect(applied(history.undo([row("棉麻混纺")]))[0].material).toBe("");
    const afterRedo = applied(history.redo([row("")]));
    history.record(change(afterRedo, [row("羊毛")]), "one:material", 1000);
    expect(history.undoCount).toBe(2);
    history.record(change([row("羊毛")], [row("羊绒")] ), "one:material", 2000);
    expect(history.undoCount).toBe(3);
    history.record(change([row("羊绒")], [row("桑蚕丝")]), undefined, 2100);
    expect(history.undoCount).toBe(4);
  });

  it("drops a typing group that returns to its original content, without combining discontinuous edits", () => {
    const history = new SelectionHistory();
    history.record(change([row("A")], [row("B")]), "typing", 0);
    history.record(change([row("B")], [row("A")]), "typing", 1);
    expect(history.canUndo).toBe(false);
    const first = change([row("A")], [row("B")]), second = change([row("remote")], [row("C")]);
    expect(mergeSelectionHistoryChanges(first, second)).toBeUndefined();
    history.record(first, "typing", 2);
    history.record(second, "typing", 3);
    expect(history.undoCount).toBe(2);
  });

  it("ignores blank storage normalization but distinguishes zero and preserves zero-prefixed codes", () => {
    expect(createSelectionHistoryChange([row(null)], [row("")], ["material"])).toBeNull();
    expect(createSelectionHistoryChange([{ _key: "one" }], [row(null)], ["material"])).toBeNull();
    const zero = change([row("")], [row(0)]);
    expect(applied(applySelectionHistoryChange([row(0)], zero, "undo"))[0].material).toBe("");
    expect(applied(applySelectionHistoryChange([row(null)], zero, "redo"))[0].material).toBe(0);
    const code = change([row("001")], [row("002")]);
    expect(applySelectionHistoryChange([row(2)], code, "undo")).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("accepts caller-approved money normalization while preserving other values and exact product codes", () => {
    const moneyEqual = (field: string, left: unknown, right: unknown) => field === "vipPrice" && Number(left) === Number(right);
    const before = [{ ...row("棉"), vipPrice: "88", xutiStyleNo: "001" }];
    const after = [{ ...before[0], vipPrice: "99", xutiStyleNo: "002" }];
    const moneyChange = change(before, after, ["vipPrice"]);
    const saved = [{ ...after[0], vipPrice: "99.00", material: "远端成分", version: 3 }];
    expect(applySelectionHistoryChange(saved, moneyChange, "undo")).toMatchObject({ ok: false, reason: "conflict", field: "vipPrice" });
    expect(applied(applySelectionHistoryChange(saved, moneyChange, "undo", undefined, moneyEqual))[0]).toMatchObject({ vipPrice: "88", material: "远端成分", version: 3 });
    const codeChange = change(before, [{ ...before[0], xutiStyleNo: "1" }], ["xutiStyleNo"]);
    expect(applySelectionHistoryChange([{ ...before[0], xutiStyleNo: "001" }], codeChange, "undo", undefined, moneyEqual)).toMatchObject({ ok: false, reason: "conflict", field: "xutiStyleNo" });
    const formatChange = change([{ ...before[0], cellColors: { material: "red" } }], [{ ...before[0], cellColors: {} }]);
    expect(applySelectionHistoryChange([{ ...before[0], cellColors: { material: null } }], formatChange, "undo", undefined, () => true)).toMatchObject({ ok: false, reason: "conflict", field: "material" });
  });

  it("restores only touched cells and formats while retaining server metadata and unrelated remote edits", () => {
    const before = [{ ...row("棉"), supplierCode: "S1", extraFields: { "custom:note": "before", "custom:other": "local" }, cellColors: { material: "red", supplierCode: "green" }, updatedAt: "old", version: 1 }];
    const after = [{ ...before[0], material: "羊毛", extraFields: { ...before[0].extraFields, "custom:note": "after" }, cellColors: { supplierCode: "green" } }];
    const stored = change(before, after, ["material", "custom:note"]);
    const live = [{ ...after[0], supplierCode: "REMOTE", extraFields: { "custom:note": "after", "custom:other": "remote" }, cellColors: { supplierCode: "blue" }, updatedAt: "new", version: 8 }];
    const original = structuredClone(live);
    const undo = applied(applySelectionHistoryChange(live, stored, "undo"));
    expect(undo[0]).toMatchObject({ material: "棉", supplierCode: "REMOTE", extraFields: { "custom:note": "before", "custom:other": "remote" }, cellColors: { material: "red", supplierCode: "blue" }, updatedAt: "new", version: 8 });
    const redo = applied(applySelectionHistoryChange(undo, stored, "redo"));
    expect(redo).toEqual(live);
    expect(redo[0].cellColors).not.toHaveProperty("material");
    expect(live).toEqual(original);
  });

  it("keeps format absence distinct from null and restores every supported formatting map", () => {
    const formats = { cellColors: "red", cellAlignments: "right", cellVerticalAlignments: "top", cellTextColors: "#123456", cellNumberFormats: { type: "currency", decimals: 2 } };
    const before: Row = { ...row("棉") }, after: Row = { ...before };
    for (const [container, value] of Object.entries(formats)) { before[container] = { material: value }; after[container] = {}; }
    const stored = change([before], [after]);
    expect(stored.cells).toHaveLength(5);
    expect(applied(applySelectionHistoryChange([after], stored, "undo"))).toEqual([before]);
    expect(applySelectionHistoryChange([{ ...after, cellColors: { material: null } }], stored, "undo")).toMatchObject({ ok: false, reason: "conflict", field: "material" });
  });

  it("preflights an entire batch atomically and does not consume history on conflicts or revoked permissions", () => {
    const history = new SelectionHistory();
    const before = [row("A"), { _key: "two", material: "B" }], after = [row("C"), { _key: "two", material: "D" }];
    history.record(change(before, after));
    expect(history.undo(after, current => current._key !== "two")).toMatchObject({ ok: false, reason: "permission", rowKey: "two" });
    expect(after.map(current => current.material)).toEqual(["C", "D"]);
    expect(history.undoCount).toBe(1);
    expect(history.undo([after[0], { ...after[1], material: "REMOTE" }])).toMatchObject({ ok: false, reason: "conflict", rowKey: "two" });
    expect(history.undo([after[0]])).toMatchObject({ ok: false, reason: "conflict", rowKey: "two" });
    expect(applied(history.undo(after))).toEqual(before);
    expect(history.undoCount).toBe(0);
  });

  it("snapshots only changed whitelisted values and clones image arrays without storing rows or derived metadata", () => {
    const before = { ...row("A"), images: [{ url: "old.png", color: "白" }], updatedAt: "old", collectionInventory: [{ available: 2 }], extraFields: { "custom:secret": "private" } };
    const after = { ...before, material: "B", images: [{ url: "new.png", color: "黑" }], updatedAt: "new", collectionInventory: [{ available: 99 }], extraFields: { "custom:secret": "changed" } };
    const stored = change([before], [after], ["material", "images", "updatedAt", "collectionInventory"]);
    expect(stored.cells.map(cell => cell.field)).toEqual(["material", "images"]);
    expect(JSON.stringify(stored)).not.toContain("private");
    after.images[0].url = "mutated-after-record.png";
    const live = { ...after, images: [{ url: "new.png", color: "黑" }] };
    const undo = applied(applySelectionHistoryChange([live], stored, "undo"));
    expect(undo[0].images).toEqual([{ url: "old.png", color: "白" }]);
    undo[0].images[0].url = "mutated-result.png";
    expect(stored.cells.find(cell => cell.field === "images")!.before.value).toEqual([{ url: "old.png", color: "白" }]);
  });

  it("restores creation timestamps after autosave normalized a draft and leaves a saveable reversal", () => {
    const before = { ...row("棉"), createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "old" };
    const after = withSelectionCreationTime(before, "2026-10-02 09:30");
    const stored = change([before], [after], ["registrationBatch"]);
    expect(stored.cells).toHaveLength(1);
    const saved: Row = { ...after, updatedAt: "saved", version: 2 };
    delete saved.creationTimeDraft;
    const undone = applied(applySelectionHistoryChange([saved], stored, "undo"));
    expect(undone[0].updatedAt).toBe("saved");
    expect(undone[0].createdAt).toBe(before.createdAt);
    expect(selectionCreationTimeForSave(undone[0])).toBe(before.createdAt);
    const redone = applied(applySelectionHistoryChange(undone, stored, "redo"));
    expect(selectionCreationTimeForSave(redone[0])).toBe("2026-10-02T01:30:00.000Z");
    const partial = withSelectionCreationTime(before, "2026-10-");
    expect(applied(applySelectionHistoryChange([before], change([before], [partial], ["registrationBatch"]), "redo"))[0].creationTimeDraft).toBe("2026-10-");
  });

  it("keeps unchanged rows by reference in a five-thousand-row table", () => {
    const before = Array.from({ length: 5000 }, (_, index) => ({ _key: String(index), material: `row${index}`, extraFields: { "custom:untouched": "large unrelated content" } }));
    const after = [...before];
    after[2000] = { ...after[2000], material: "changed" };
    const stored = change(before, after);
    expect(stored.cells).toHaveLength(1);
    expect(JSON.stringify(stored).length).toBeLessThan(300);
    const undo = applied(applySelectionHistoryChange(after, stored, "undo"));
    expect(undo[1999]).toBe(after[1999]);
    expect(undo[2000]).not.toBe(after[2000]);
    expect(undo[2000].extraFields).toBe(after[2000].extraFields);
  });
});

describe("shared table operation history", () => {
  type Operation = { kind: "cell" | "row" | "layout"; index: number; token?: string };

  it("shares one ten-step limit across cell, row and layout operations", () => {
    const history = new SelectionOperationHistory<Operation>(100);
    const kinds = ["cell", "row", "layout"] as const;
    for (let index = 0; index < 12; index++) history.record({ kind: kinds[index % kinds.length], index });
    expect(history.undoCount).toBe(10);
    for (let index = 11; index >= 2; index--) {
      expect(history.peek("undo")).toEqual({ kind: kinds[index % kinds.length], index });
      history.commit("undo");
    }
    expect(history.canUndo).toBe(false);
    expect(history.redoCount).toBe(10);
    for (let index = 2; index < 12; index++) {
      expect(history.peek("redo")?.index).toBe(index);
      history.commit("redo");
    }
    expect(history.undoCount).toBe(10);
    expect(history.canRedo).toBe(false);
  });

  it("retains an operation after a failed asynchronous attempt until explicitly committed", () => {
    const history = new SelectionOperationHistory<Operation>();
    const entry: Operation = { kind: "row", index: 1, token: "delete-token" };
    history.record(entry);
    expect(history.peek("undo")).toBe(entry);
    // A failed request reads the operation but does not commit it.
    expect(history.peek("undo")).toBe(entry);
    expect([history.undoCount, history.redoCount]).toEqual([1, 0]);
    history.commit("undo");
    expect([history.undoCount, history.redoCount]).toEqual([0, 1]);
    history.clear();
    expect([history.canUndo, history.canRedo, history.peek("undo"), history.peek("redo")]).toEqual([false, false, undefined, undefined]);
    expect(history.commit("redo")).toBeUndefined();
  });

  it("places fresh row restoration tokens on the opposite stack after successful transitions", () => {
    const history = new SelectionOperationHistory<Operation>();
    history.record({ kind: "row", index: 1, token: "deleted-row-v1" });
    const restored: Operation = { kind: "row", index: 1, token: "restored-row-v2" };
    history.commit("undo", restored);
    expect(history.peek("redo")).toBe(restored);
    const deletedAgain: Operation = { kind: "row", index: 1, token: "deleted-row-v3" };
    history.commit("redo", deletedAgain);
    expect(history.peek("undo")).toBe(deletedAgain);
  });

  it("merges an explicitly grouped edit, separates other operations and clears redo on a new branch", () => {
    const history = new SelectionOperationHistory<Operation>();
    const merge = (earlier: Operation, later: Operation) => earlier.kind === "cell" && later.kind === "cell" ? later : undefined;
    history.record({ kind: "cell", index: 1 }, "typing", merge, 0);
    history.record({ kind: "cell", index: 2 }, "typing", merge, 500);
    expect(history.undoCount).toBe(1);
    expect(history.peek("undo")?.index).toBe(2);
    history.record({ kind: "layout", index: 3 }, "typing", merge, 600);
    expect(history.undoCount).toBe(2);
    history.commit("undo");
    history.record({ kind: "cell", index: 4 }, "typing", merge, 700);
    expect([history.undoCount, history.redoCount]).toEqual([2, 0]);
    history.commit("undo");
    history.commit("undo");
    expect(history.peek("redo")?.index).toBe(2);
  });
});
