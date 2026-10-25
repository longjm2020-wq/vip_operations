// An in-flight marker is written before a paid request. While the worker is
// running it means "waiting for the provider", not "lost provider result".
export function submissionStatus(job, task) {
  const unresolved = Boolean(job && !job.providerRequestId && (
    job.payload?.compileSubmission?.state === "inflight" ||
    job.payload?.videoSubmission?.state === "inflight" ||
    job.payload?.keyframeGate?.frames?.some(frame => frame.submission?.state === "inflight" && !frame.requestId)
  ));
  return {
    providerRequestInFlight: unresolved && job.status === "running",
    reconciliationRequired: unresolved && job.status === "paused" && task?.stage === "attention",
  };
}
