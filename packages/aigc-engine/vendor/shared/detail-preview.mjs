import { DEFAULT_DETAIL_RATIOS } from "./detail-ratios.mjs";

// Queue completion order is unrelated to page order. Keep the latest successful
// version of each enabled module, retaining it while a newer version is running.
export function detailPreviewPages(project) {
  const latest = new Map();
  for (const job of project.jobs || []) {
    if (job.status !== "done" || !job.outputAssetId) continue;
    const previous = latest.get(job.moduleId);
    if (!previous || (Number(job.version) || 0) >= (Number(previous.version) || 0)) latest.set(job.moduleId, job);
  }
  return (project.modules || []).filter(module => module.enabled).flatMap(module => {
    const job = latest.get(module.id);
    const outputType = module.id.startsWith("MAIN-") || module.type === "main" ? "main_image" : "detail_page";
    return job ? [{ ...job, title: module.name, outputType, outputRatio: job.unit?.output_ratio || DEFAULT_DETAIL_RATIOS[outputType] }] : [];
  });
}
