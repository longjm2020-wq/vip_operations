import {
  compassDimensions,
  type CompassDimension,
} from "../../../packages/contracts/src/compass-analytics";
import {
  compassUpdateActive,
  type CompassUpdateDimensionProgress,
  type CompassUpdateJob,
  type CompassUpdateStatusView,
} from "../../../packages/contracts/src/compass-update";

export const compassProgressSteps = ["准备", "下载", "解析", "导入", "校验"];
const stages = {
  QUEUED: ["等待处理", 0],
  FINDING: ["查找目标报表", 0],
  PREPARING: ["等待平台生成", 0],
  DOWNLOADING: ["下载原始文件", 1],
  PARSING: ["解析报表", 2],
  IMPORTING: ["分批导入数据", 3],
  VERIFYING: ["核验数据来源", 4],
  COMPLETE: ["已导入并核验", 5],
} as const;

export function compassDimensionProgress(
  job: CompassUpdateJob,
  dimension: CompassDimension,
) {
  const detail = job.progress?.dimensions[dimension];
  const verified = job.completedDimensions.includes(dimension);
  // A stage message cannot override the authoritative source verification result.
  const stage: CompassUpdateDimensionProgress["stage"] = verified
    ? "COMPLETE"
    : detail?.stage === "COMPLETE"
      ? "VERIFYING"
      : (detail?.stage ?? "QUEUED");
  const [label, stageIndex] = stages[stage];
  const importFraction =
    stage === "IMPORTING" && detail?.totalRows && detail.totalRows > 0
      ? Math.min(1, Math.max(0, detail.processedRows / detail.totalRows))
      : 0;
  return {
    stage,
    label,
    stageIndex,
    verified,
    detail,
    percent: Math.floor((stageIndex + importFraction) * 20),
    hasDetail: !!detail,
  };
}

export function compassOverallProgress(job: CompassUpdateJob) {
  const percent = Math.floor(
    compassDimensions.reduce(
      (sum, dimension) =>
        sum + compassDimensionProgress(job, dimension).percent,
      0,
    ) / compassDimensions.length,
  );
  return job.status === "COMPLETE" &&
    compassDimensions.every((dimension) =>
      job.completedDimensions.includes(dimension),
    )
    ? 100
    : Math.min(99, percent);
}

export function isHistoricalCompassUpdate(
  job: CompassUpdateJob,
  target: CompassUpdateStatusView["target"],
) {
  return (
    !!target &&
    !compassUpdateActive.includes(job.status) &&
    (job.targetStartDate !== target.startDate ||
      job.targetEndDate !== target.endDate)
  );
}

export function compassProgressPhase(job: CompassUpdateJob) {
  if (["LOGIN_REQUIRED", "VERIFICATION_REQUIRED"].includes(job.status))
    return "已暂停，保留最后确认进度";
  if (["FAILED", "PARTIAL"].includes(job.status))
    return "已停止，保留最后确认进度";
  if (job.status === "COMPLETE") return "三个维度的数据来源已核验";
  if (!job.progress)
    return job.status === "QUEUED"
      ? "等待后台执行"
      : "后台正在处理，等待阶段明细";
  return {
    QUEUED: "等待后台执行",
    CHECKING_SOURCES: "检查目标日期已有数据",
    OPENING_REPORTS: "打开罗盘报表中心",
    PROCESSING_REPORTS: "逐张处理三维报表",
    VERIFYING_SOURCES: "最终核验三个维度的数据来源",
    COMPLETE: "等待任务完成确认",
  }[job.progress.phase];
}
