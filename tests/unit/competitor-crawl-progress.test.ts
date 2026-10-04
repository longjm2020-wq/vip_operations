import { describe, expect, it } from "vitest";
import { competitorCrawlProgress } from "../../packages/contracts/src/competitor-crawl-progress.js";

describe("competitor collection progress from durable work counts", () => {
  it("starts at zero without treating old samples as current progress", () => {
    expect(competitorCrawlProgress()).toEqual({
      captured: 0,
      details: 0,
      percent: 0,
    });
    expect(
      competitorCrawlProgress({ capturedCount: 0, detailCount: 9 }).percent,
    ).toBe(0);
  });
  it("tracks saved rankings and each detail batch, including a short list", () => {
    expect(
      competitorCrawlProgress({ capturedCount: 50, detailCount: 0 }).percent,
    ).toBe(50);
    expect(
      competitorCrawlProgress({ capturedCount: 50, detailCount: 15 }).percent,
    ).toBe(65);
    expect(
      competitorCrawlProgress({ capturedCount: 20, detailCount: 20 }),
    ).toEqual({ captured: 20, details: 20, percent: 100 });
  });
  it("bounds malformed counts without fabricating completion", () => {
    expect(
      competitorCrawlProgress({ capturedCount: NaN, detailCount: Infinity })
        .percent,
    ).toBe(0);
    expect(
      competitorCrawlProgress({ capturedCount: -5, detailCount: 1 }).percent,
    ).toBe(0);
    expect(
      competitorCrawlProgress({ capturedCount: 50, detailCount: 100 }).details,
    ).toBe(50);
  });
});
