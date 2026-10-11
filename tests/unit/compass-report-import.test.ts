import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCompassDownload,
  StaleCompassReportError,
} from "../../apps/worker/src/compass-report-import.js";
import { shiftCompassDate } from "../../packages/contracts/src/compass-analytics.js";

const folders: string[] = [];
const targetStart = "2026-09-11",
  targetEnd = "2026-10-10";
const headers = [
  "日期",
  "P_SPU_ID",
  "款号",
  "销售额",
  "销售量",
  "销售额(不含拒退)",
  "销售量(不含拒退)",
  "退货件数",
  "退货金额",
  "可售库存",
];
function csv(start: string, mutate?: (rows: string[][]) => void) {
  const rows = Array.from({ length: 30 }, (_, index) => [
    shiftCompassDate(start, index),
    "1287391390217097216",
    "000123",
    "12.30",
    "2",
    "12.30",
    "2",
    "0",
    "0",
    "9",
  ]);
  mutate?.(rows);
  return [headers, ...rows].map((row) => row.join(",")).join("\n");
}
async function original(bytes: string) {
  const folder = await mkdtemp(join(tmpdir(), "compass-import-fixture-"));
  folders.push(folder);
  const path = join(folder, "original.csv");
  await writeFile(path, bytes, "utf8");
  return {
    path,
    fileName: "按款号（近30天）.csv",
    dimension: "style" as const,
  };
}
afterEach(async () => {
  // These directories were created by this fixture, never a supplied path.
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});

describe("original Compass download date validation", () => {
  it("identifies a complete valid report for another period as a stale source", async () => {
    const file = await original(csv("2026-09-10"));
    await expect(
      readCompassDownload(file, targetStart, targetEnd),
    ).rejects.toMatchObject({
      name: "StaleCompassReportError",
      actualStartDate: "2026-09-10",
      actualEndDate: "2026-10-09",
      expectedStartDate: targetStart,
      expectedEndDate: targetEnd,
    });
    await expect(
      readCompassDownload(file, targetStart, targetEnd),
    ).rejects.toBeInstanceOf(StaleCompassReportError);
  });
  it("keeps the original hash, long identifiers and leading zeros for the target period", async () => {
    const bytes = csv(targetStart),
      file = await original(bytes);
    const result = await readCompassDownload(file, targetStart, targetEnd);
    expect(result.fileHash).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(result.report).toMatchObject({
      dimension: "style",
      startDate: targetStart,
      endDate: targetEnd,
      dateCount: 30,
    });
    expect(result.report.records[0]).toMatchObject({
      spuId: "1287391390217097216",
      styleNo: "000123",
    });
  });
  it.each([
    {
      cause: "metric",
      mutate: (rows: string[][]) => {
        rows[0][3] = "invalid";
      },
      message: "有效数值",
    },
    {
      cause: "missing daily date",
      mutate: (rows: string[][]) => {
        rows.splice(10, 1);
      },
      message: "不连续",
    },
  ])(
    "does not retry malformed $cause as a stale period",
    async ({ mutate, message }) => {
      const file = await original(csv("2026-09-10", mutate));
      const result = await readCompassDownload(
        file,
        targetStart,
        targetEnd,
      ).catch((error) => error);
      expect(result).toBeInstanceOf(Error);
      expect(result).not.toBeInstanceOf(StaleCompassReportError);
      expect(result.message).toContain(message);
    },
  );
  it("rejects wrong dimensions and filename/content contradictions before stale detection", async () => {
    const file = await original(csv("2026-09-10"));
    await expect(
      readCompassDownload(
        { ...file, dimension: "article" },
        targetStart,
        targetEnd,
      ),
    ).rejects.toThrow("维度");
    const result = await readCompassDownload(
      { ...file, fileName: "按款号_20260911-20261010_20261011.csv" },
      targetStart,
      targetEnd,
    ).catch((error) => error);
    expect(result).not.toBeInstanceOf(StaleCompassReportError);
    expect(result.message).toContain("文件名统计区间");
  });
});
