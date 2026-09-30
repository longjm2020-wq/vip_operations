import { describe, expect, it } from "vitest";
import { selectionScrollSpeed } from "../../apps/web/src/selection-drag.js";

describe("selection edge scrolling", () => {
  it("scrolls in the edge direction and stops in the interior", () => {
    expect(selectionScrollSpeed(100, 100, 500)).toBe(-900);
    expect(selectionScrollSpeed(500, 100, 500)).toBe(900);
    expect(selectionScrollSpeed(300, 100, 500)).toBe(0);
    expect(selectionScrollSpeed(124, 100, 500)).toBe(-450);
    expect(selectionScrollSpeed(476, 100, 500)).toBe(450);
  });
  it("caps speed outside the sheet and handles a clipped viewport", () => {
    expect(selectionScrollSpeed(-1000, 100, 500)).toBe(-900);
    expect(selectionScrollSpeed(1000, 100, 500)).toBe(900);
    expect(selectionScrollSpeed(120, 100, 160)).toBe(0);
    expect(selectionScrollSpeed(100, 100, 100)).toBe(0);
  });
});
