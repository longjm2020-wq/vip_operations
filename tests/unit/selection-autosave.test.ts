import { describe, expect, it } from "vitest";
import { mergeSelectionRemote, mergeSelectionSave, normalizeSelection, SelectionSaveAttempts } from "../../apps/web/src/selection-autosave.js";

describe("selection autosave", () => {
  it("uses distinct keys for successive edits to the same row", () => {
    const attempts = new SelectionSaveAttempts();
    const row = { _key: "row", id: "1", material: "棉" };
    const first = attempts.start(row, { material: "棉" });
    attempts.succeed(row._key);
    const second = attempts.start({ ...row, material: "羊毛" }, { material: "羊毛" });
    expect(second.key).not.toBe(first.key);
  });

  it("pauses after a failed request and retries uncertain creation without duplicates", () => {
    const attempts = new SelectionSaveAttempts();
    const row = { _key: "new", material: "棉" };
    const first = attempts.start(row, { material: "棉" });
    attempts.fail(row._key, row);
    const edited = { ...row, material: "羊毛" };
    expect(attempts.eligible(row)).toBe(false);
    expect(attempts.eligible(edited)).toBe(false);
    attempts.retry();
    expect(attempts.eligible(edited)).toBe(true);
    expect(attempts.start(edited, { material: "羊毛" })).toEqual(first);
    const merged = mergeSelectionSave(edited, first.sent, { ...row, id: "42", updatedAt: "new" });
    expect(merged).toMatchObject({ id: "42", material: "羊毛", updatedAt: "new" });
  });

  it("only resumes invalid data after an edit; a conflict stays paused", () => {
    const attempts = new SelectionSaveAttempts();
    const row = { _key: "row", vipPrice: "-1" };
    const first = attempts.start(row, { vipPrice: "-1" });
    attempts.fail(row._key, row, 400);
    expect(attempts.eligible(row)).toBe(false);
    const edited = { ...row, vipPrice: "100" };
    expect(attempts.eligible(edited)).toBe(true);
    expect(attempts.start(edited, { vipPrice: "100" }).key).not.toBe(first.key);
    attempts.fail(row._key, edited, 409);
    expect(attempts.eligible({ ...edited, vipPrice: "200" })).toBe(false);
  });

  it("keeps changes made during a save, while adopting the server version and normalization", () => {
    const sent = { _key: "row", color: "白", vipPrice: "99", images: [], updatedAt: "old" };
    const current = { ...sent, color: "白/黑", images: [{ id: "new-image" }] };
    const saved = { ...sent, id: "1", vipPrice: "99.00", updatedAt: "new", version: 2 };
    expect(mergeSelectionSave(current, sent, saved)).toMatchObject({
      color: "白/黑", images: [{ id: "new-image" }], vipPrice: "99.00", updatedAt: "new", version: 2,
    });
  });

  it("normalizes a saved date before another edit is submitted", () => {
    expect(normalizeSelection({ registrationBatch: "2026-09-28T00:00:00.000Z" }).registrationBatch).toBe("2026-09-28");
    expect(normalizeSelection({ registrationBatch: "2026-09-28" }).registrationBatch).toBe("2026-09-28");
    expect(normalizeSelection({ registrationBatch: null }).registrationBatch).toBeNull();
  });

  it("shows remote changes to other fields while retaining a draft and rebasing its version", () => {
    const before = { _key:"a",id:"1",color:"白",material:"棉",updatedAt:"old",version:1,extraFields:{"custom:one":"a","custom:two":"b"} };
    const current = { ...before,color:"黑",extraFields:{...before.extraFields,"custom:one":"local"} };
    const incoming = { ...before,material:"羊毛",extraFields:{...before.extraFields,"custom:two":"remote"},updatedAt:"new",version:2 };
    expect(mergeSelectionRemote(current,before,incoming)).toEqual({row:{...incoming,color:"黑",extraFields:{"custom:one":"local","custom:two":"remote"}},conflicts:[]});
  });

  it("retains a colliding draft and the old version so a retry cannot overwrite another user", () => {
    const before = { _key:"a",id:"1",material:"棉",color:"白",updatedAt:"old",version:1 };
    const result = mergeSelectionRemote({...before,material:"local"},before,{...before,material:"remote",color:"黑",updatedAt:"new",version:2});
    expect(result.conflicts).toEqual(["material"]);
    expect(result.row).toMatchObject({material:"local",color:"黑",updatedAt:"old",version:1});
    const attempts = new SelectionSaveAttempts(); attempts.fail("a",result.row,409);
    expect(attempts.eligible({...result.row,material:"another draft"})).toBe(false);
  });

  it("drops newly forbidden local values and formatting instead of retaining a private draft", () => {
    const before = {_key:"a",id:"1",material:"private",color:"白",extraFields:{"custom:secret":"secret"},cellColors:{material:"red"}};
    const current = {...before,material:"private draft",color:"黑",extraFields:{"custom:secret":"secret draft"},cellColors:{material:"blue"}};
    const incoming = {...before,material:null,extraFields:{"custom:secret":""},cellColors:{},cellAccess:{material:"deny","custom:secret":"deny",color:"edit"},defaultCellAccess:"edit",policyRevision:1};
    expect(mergeSelectionRemote(current,before,incoming)).toEqual({row:{...incoming,color:"黑"},conflicts:[]});
  });

  it("keeps local format removal and separate remote format changes", () => {
    const before = {_key:"a",id:"1",cellColors:{material:"red",color:"green"}};
    const result = mergeSelectionRemote({...before,cellColors:{color:"green"}},before,{...before,cellColors:{material:"red",color:"blue"}});
    expect(result.row.cellColors).toEqual({color:"blue"});
    expect(result.conflicts).toEqual([]);
  });
});

