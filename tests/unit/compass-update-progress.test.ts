import { describe, expect, it } from "vitest";
import {
  compassDimensionProgress,
  compassOverallProgress,
  compassProgressPhase,
  isHistoricalCompassUpdate,
} from "../../apps/web/src/compass-update-progress.js";
import {
  initialCompassUpdateProgress,
  type CompassUpdateJob,
} from "../../packages/contracts/src/compass-update.js";

function job(): CompassUpdateJob {
  return {
    id: "progress-fixture",
    status: "RUNNING",
    targetStartDate: "2026-09-20",
    targetEndDate: "2026-10-19",
    requestedAt: "2026-10-20T02:00:00Z",
    startedAt: "2026-10-20T02:00:01Z",
    completedAt: null,
    completedDimensions: [],
    sourceIds: {},
    note: "fixture",
    progress: initialCompassUpdateProgress([], "2026-10-20T02:01:00Z"),
  };
}

describe("Compass report progress integrity", () => {
  it("does not accept a completion stage without verified sources", () => {
    const value = job();
    value.progress!.dimensions.style!.stage = "COMPLETE";
    expect(compassDimensionProgress(value, "style")).toMatchObject({
      stage: "VERIFYING", verified: false, percent: 80,
    });
    value.completedDimensions = ["style", "article", "barcode"];
    expect(compassOverallProgress(value)).toBe(99);
    value.status = "COMPLETE";
    expect(compassOverallProgress(value)).toBe(100);
  });

  it("keeps legacy task counters unknown and uses only verified dimensions", () => {
    const value = job();
    delete value.progress;
    value.completedDimensions = ["style"];
    expect(compassDimensionProgress(value, "style")).toMatchObject({
      verified: true, percent: 100, hasDetail: false,
    });
    expect(compassDimensionProgress(value, "article")).toMatchObject({
      stage: "QUEUED", percent: 0, detail: undefined,
    });
    expect(compassOverallProgress(value)).toBe(33);
  });

  it("does not infer import completion when the row total is unknown or empty", () => {
    const value = job(), detail = value.progress!.dimensions.style!;
    Object.assign(detail, { stage: "IMPORTING", totalRows: null, processedRows: 1000 });
    expect(compassDimensionProgress(value, "style").percent).toBe(60);
    detail.totalRows = 0;
    expect(compassDimensionProgress(value, "style").percent).toBe(60);
    detail.totalRows = 2500;
    detail.processedRows = 1000;
    expect(compassDimensionProgress(value, "style").percent).toBe(68);
    detail.processedRows = 2500;
    expect(compassDimensionProgress(value, "style").percent).toBe(80);
  });

  it("preserves confirmed counters while waiting for login or after failure", () => {
    const value = job();
    Object.assign(value.progress!.dimensions.style!, {
      stage: "IMPORTING", totalRows: 2500, processedRows: 1000, batch: 1, totalBatches: 3,
    });
    const confirmed = compassOverallProgress(value);
    for (const status of ["LOGIN_REQUIRED", "VERIFICATION_REQUIRED", "PARTIAL", "FAILED"] as const) {
      value.status = status;
      expect(compassOverallProgress(value)).toBe(confirmed);
      expect(compassProgressPhase(value)).toContain("保留最后确认进度");
    }
  });

  it("uses the server target to identify old results while retaining an active task", () => {
    const value = job(), target = { startDate: "2026-09-21", endDate: "2026-10-20" };
    expect(isHistoricalCompassUpdate(value, target)).toBe(false);
    value.status = "COMPLETE";
    expect(isHistoricalCompassUpdate(value, target)).toBe(true);
    expect(isHistoricalCompassUpdate(value, undefined)).toBe(false);
    expect(isHistoricalCompassUpdate(value, { startDate: value.targetStartDate, endDate: value.targetEndDate })).toBe(false);
  });
});
