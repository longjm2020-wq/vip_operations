import { describe, expect, it, vi } from "vitest";
import type { SelectionImageFeatures } from "../../apps/api/src/modules/style-selections/image-search-features.js";

// Test learning and focus gates independently; real image comparisons remain
// covered by selection-image-search-features.test.ts and backend integration.
vi.mock("../../apps/api/src/modules/style-selections/image-search-features.js", () => ({
  selectionImageDistance: (_query: unknown, features: { testDistance: number }) => features.testDistance,
}));
import { canFocusSelectionImageMatch, selectionImageLearningEvidence } from "../../apps/api/src/modules/style-selections/image-search-learning.js";

const features = (testDistance: number) => ({ testDistance } as unknown as SelectionImageFeatures);
const query = features(0);
const example = (testDistance: number, positiveCount = 1, overrides: { rowId?: string; imageId?: string; negativeCount?: number } = {}) => ({
  rowId: "10", imageId: "photo-1", imageUrl: "/images/current-photo", features: features(testDistance), positiveCount, negativeCount: 0, ...overrides,
});
const candidate = (rowId = "10", imageId = "photo-1") => ({ rowId, image: { id: imageId, url: "/images/current-photo" } });
const match = (imageSimilarity: number, confirmations: number, conflicted = false) => ({ imageSimilarity, confirmations, conflicted });

describe("selection image feedback learning", () => {
  it("does not inflate similarity from votes or learn examples at or below the strict 90% threshold", () => {
    const evidence = selectionImageLearningEvidence(query, { examples: [example(0.11, 100), example(0.1, 100), example(0.09999999999999999, 100), example(0.07)], rejected: [] });
    expect(evidence(candidate())).toEqual({ similarity: 93, confirmations: 1, conflicted: false });
    const observed = evidence(candidate());
    expect(canFocusSelectionImageMatch([match(observed.similarity, observed.confirmations, observed.conflicted)])).toBe(false);
  });

  it("uses the best matching confirmed example while summing separate confirmations for the same style", () => {
    const evidence = selectionImageLearningEvidence(query, { examples: [example(0.02), example(0.01, 1, { imageId: "photo-2" })], rejected: [] });
    expect(evidence(candidate())).toEqual({ similarity: 98, confirmations: 2, conflicted: false });
    expect(evidence(candidate("10", "photo-2"))).toEqual({ similarity: 99, confirmations: 2, conflicted: false });
    expect(evidence(candidate("20"))).toEqual({ similarity: 0, confirmations: 0, conflicted: false });
  });

  it("a nearby rejected example vetoes focused learning for every image of that style", () => {
    const evidence = selectionImageLearningEvidence(query, {
      examples: [example(0.001, 5), example(0.002, 5, { imageId: "photo-2" }), example(0.01, 2, { rowId: "20" })],
      rejected: [example(0.09, 0, { negativeCount: 1 })],
    });
    expect(evidence(candidate())).toEqual({ similarity: 0, confirmations: 0, conflicted: true });
    expect(evidence(candidate("10", "photo-2"))).toEqual({ similarity: 0, confirmations: 0, conflicted: true });
    expect(evidence(candidate("20"))).toEqual({ similarity: 99, confirmations: 2, conflicted: false });
  });

  it("an unrelated rejected picture does not suppress a matching positive example", () => {
    const evidence = selectionImageLearningEvidence(query, {
      examples: [example(0.01, 2)], rejected: [example(0.2, 0, { negativeCount: 1 })],
    });
    expect(evidence(candidate())).toEqual({ similarity: 99, confirmations: 2, conflicted: false });
  });
});

describe("selection image single-result focus gate", () => {
  it.each([
    { name: "two confirmations with exact 98% and exact two-point lead", matches: [match(98, 2), match(96, 0)], expected: true },
    { name: "two confirmations and no competing candidate", matches: [match(98, 2)], expected: true },
    { name: "only one confirmation", matches: [match(100, 1)], expected: false },
    { name: "a conflicting rejection", matches: [match(100, 5, true)], expected: false },
    { name: "score just below 98%", matches: [match(97.999, 5), match(92, 0)], expected: false },
    { name: "lead just below two points", matches: [match(99, 5), match(97.001, 0)], expected: false },
    { name: "tie with another candidate", matches: [match(100, 5), match(100, 0)], expected: false },
    { name: "no candidates", matches: [], expected: false },
  ])("$name", ({ matches, expected }) => {
    expect(canFocusSelectionImageMatch(matches)).toBe(expected);
  });
});
