import { describe, expect, it } from "vitest";
import { duplicateStyleCounts } from "../../apps/web/src/selection-duplicates.js";

describe("selection duplicate styles", () => {
  it("highlights both matching rows, ignores blanks and keeps exact case", () => {
    const counts = duplicateStyleCounts([
      { _key: "1", xutiStyleNo: " XT-01 " }, { _key: "2", xutiStyleNo: "XT-01" },
      { _key: "3", xutiStyleNo: "" }, { _key: "4", xutiStyleNo: "  " },
      { _key: "5", xutiStyleNo: "xt-01" },
    ]);
    expect(counts.get("XT-01")).toBe(2);
    expect(counts.has("xt-01")).toBe(false);
    expect(counts.has("")).toBe(false);
  });

  it("uses all saved rows even when the visible list is filtered and updates local edits", () => {
    const original = new Map([["1", { _key: "1", id: "1", xutiStyleNo: "OLD" }]]);
    const counts = duplicateStyleCounts(
      [{ _key: "1", id: "1", xutiStyleNo: "NEW" }, { _key: "local", xutiStyleNo: "NEW" }],
      [{ xutiStyleNo: "OLD", count: 2 }, { xutiStyleNo: "NEW", count: 1 }],
      original,
    );
    expect(counts.has("OLD")).toBe(false);
    expect(counts.get("NEW")).toBe(3);
  });
});
