import { describe, expect, it } from "vitest";
import { sortSelectionSizes } from "../../packages/contracts/src/selection-sizes.js";
describe("selection size order", () => {
  it("follows dropdown order instead of click order", () => {
    expect(sortSelectionSizes("L/S")).toBe("S/L");
    expect(sortSelectionSizes("S/M/L/XL/XS/6XL/2XL")).toBe("XS/S/M/L/XL/2XL/6XL");
  });
  it("deduplicates and keeps custom sizes stable after standard sizes", () => {
    expect(sortSelectionSizes("均码/L/特大/S/L/ XS ")).toBe("XS/S/L/均码/特大");
    expect(sortSelectionSizes("均码/F/L/6XL/S")).toBe("S/L/6XL/F/均码");
    expect(sortSelectionSizes(null)).toBe("");
    expect(sortSelectionSizes(" / ")).toBe("");
  });
});
