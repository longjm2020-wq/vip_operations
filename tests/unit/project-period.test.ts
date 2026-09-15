import { describe, expect, it } from "vitest";
import {
  projectPeriod,
  projectBaseName,
} from "../../apps/web/src/project-period.js";

describe("project date label", () => {
  it("uses start ISO week and selected dates", () => {
    expect(projectPeriod("2026-09-14", "2026-09-20")).toBe(
      "（第38周 9.14-9.20）",
    );
    expect(projectPeriod("2027-01-01", "2027-01-03")).toBe(
      "（第53周 1.1-1.3）",
    );
    expect(projectPeriod("2026-12-28", "2027-01-03")).toBe(
      "（第53周 2026.12.28-2027.1.3）",
    );
  });
  it("hides invalid and incomplete periods", () => {
    for (const [a, b] of [
      ["", "2026-09-20"],
      ["2026-02-30", "2026-03-03"],
      ["2026-09-20", "2026-09-14"],
    ])
      expect(projectPeriod(a, b)).toBe("");
  });
  it("removes only the current generated suffix on reopening", () => {
    expect(
      projectBaseName("新品（第38周 9.14-9.20）", "2026-09-14", "2026-09-20"),
    ).toBe("新品");
    expect(
      projectBaseName("新品（内部名称）", "2026-09-14", "2026-09-20"),
    ).toBe("新品（内部名称）");
  });
});
