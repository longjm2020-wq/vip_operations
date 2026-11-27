import { settle } from "./access.mjs";

const retiredReason = "原视频超分服务已下线，原视频与历史回执已保留";

export function releaseEnhancements(data, jobId, reason = retiredReason) {
  for (const request of Object.values(data.platform?.requests || {})) {
    if (request.jobId === jobId && request.quote?.kind === "enhance")
      settle(data, request.id, false, reason);
  }
}

export function reconcileRetiredEnhancements(data, jobId) {
  const job = data.jobs?.[jobId];
  const enhancement = job?.payload?.enhancement;
  if (!enhancement) return;
  const now = new Date().toISOString();
  const task = data.appState?.tasks?.find((item) => item.id === job.taskId);
  for (const [unitId, record] of Object.entries(enhancement.records || {})) {
    if (!record || ["completed", "failed"].includes(record.state)) continue;
    Object.assign(record, {
      state: "failed",
      error: retiredReason,
      finishedAt: now,
    });
    task?.logs?.push({
      at: now,
      level: "warning",
      message: `${unitId} ${retiredReason}。`,
    });
  }
  releaseEnhancements(data, jobId);
}
