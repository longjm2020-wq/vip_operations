import { describe, expect, it } from "vitest";
import { selectionLayoutSchema } from "../../packages/contracts/src/selection-layout.js";
import { shouldAdoptSharedView } from "../../apps/web/src/selection-shared-view.js";

describe("shared column filters (筛选对所有人可见)", () => {
  it("followers always track the shared view", () => {
    expect(shouldAdoptSharedView(0, true, 0)).toBe(true);
    expect(shouldAdoptSharedView(5, true, 9)).toBe(true);
  });
  it("users on personal filters keep them until a newer shared view is published", () => {
    expect(shouldAdoptSharedView(3, false, 3)).toBe(false);
    expect(shouldAdoptSharedView(2, false, 3)).toBe(false);
    expect(shouldAdoptSharedView(4, false, 3)).toBe(true);
  });
  it("legacy personal-filter users without an opt-out revision adopt any published view, but not an empty table", () => {
    const legacy = selectionLayoutSchema.parse({ columns: [], followShared: false });
    expect(legacy.sharedFilterOptOutRevision).toBe(0);
    expect(shouldAdoptSharedView(1, legacy.followShared, legacy.sharedFilterOptOutRevision)).toBe(true);
    // Protected tables return revision 0 to non-admins, so nothing is adopted.
    expect(shouldAdoptSharedView(0, legacy.followShared, legacy.sharedFilterOptOutRevision)).toBe(false);
  });
});
