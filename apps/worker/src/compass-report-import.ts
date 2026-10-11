import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readWorkbook } from "../../web/src/sheet-excel.js";
import {
  normalizeCompassWorkbook,
  type CompassDimension,
} from "../../../packages/contracts/src/compass-analytics.js";

/** A valid original report for the requested dimension, but for another period. */
export class StaleCompassReportError extends Error {
  constructor(
    public readonly actualStartDate: string,
    public readonly actualEndDate: string,
    public readonly expectedStartDate: string,
    public readonly expectedEndDate: string,
  ) {
    super(
      `下载报表日期为 ${actualStartDate} 至 ${actualEndDate}，未覆盖本次要求的 ${expectedStartDate} 至 ${expectedEndDate}，保留原有数据`,
    );
    this.name = "StaleCompassReportError";
  }
}

export async function readCompassDownload(
  file: { path: string; fileName: string; dimension: CompassDimension },
  startDate: string,
  endDate: string,
) {
  if ((await stat(file.path)).size > 100 * 1024 * 1024)
    throw Error("罗盘报表超过100MB限制");
  const bytes = await readFile(file.path);
  const sheets = await readWorkbook(new File([bytes], file.fileName), {
    formattedCells: true,
    dateTimeColumns: ["首次上架时间"],
    maxFileSizeMB: 100,
    maxRows: 200000,
  });
  if (sheets.length !== 1) throw Error("请使用罗盘下载中心的单工作表原始报表");
  const report = normalizeCompassWorkbook(sheets[0].rows, file.fileName);
  if (report.dimension !== file.dimension)
    throw Error("下载的报表维度与任务不一致");
  if (report.startDate !== startDate || report.endDate !== endDate)
    throw new StaleCompassReportError(
      report.startDate,
      report.endDate,
      startDate,
      endDate,
    );
  return { report, fileHash: createHash("sha256").update(bytes).digest("hex") };
}
