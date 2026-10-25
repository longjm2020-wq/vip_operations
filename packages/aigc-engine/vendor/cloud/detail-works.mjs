import { isMainImageModule } from "../shared/detail-main-images.mjs";

// One archived work per successful image version. The marker stays on the job
// after a library record is deleted, so backfilling never resurrects it.
export function archiveDetailWorks(data, onlyProjectId) {
  const works = data.appState.works ||= [];
  const ids = new Set(works.map(work => work.id));
  for (const project of Object.values(data.detailProjects || {})) {
    if (onlyProjectId && project.id !== onlyProjectId) continue;
    for (const reference of project.jobs || []) {
      const job = data.detailJobs?.[reference.id] || reference;
      const asset = data.assets?.[job.outputAssetId];
      if (job.status !== "done" || job.workArchivedAt || reference.workArchivedAt || !asset || !project.ownerId || job.projectId !== project.id || job.ownerId !== project.ownerId || asset.ownerId !== project.ownerId) continue;
      const module = (project.modules || []).find(item => item.id === job.moduleId);
      const isMain = module ? isMainImageModule(module) : String(job.moduleId).startsWith("MAIN-") || job.unit?.output_ratio === "1:1";
      const outputType = ["detail_page", "main_image"].includes(job.outputType) ? job.outputType : isMain ? "main_image" : "detail_page";
      const title = job.moduleName || module?.name || (outputType === "main_image" ? "主图" : "详情页");
      const timestamp = job.completedAt || job.createdAt || project.updatedAt;
      const image = { path: asset.id || job.outputAssetId, name: asset.name || `${title}.png`, kind: "output", size: asset.size || 0, mime: asset.mime };
      const id = `detail-${job.id}`;
      if (!ids.has(id)) {
        works.push({ id, ownerId: project.ownerId, projectId: project.id, category: outputType, title: `${project.name} · ${title}`, sourceProjectName: project.name, createdAt: timestamp, updatedAt: timestamp, cover: image, images: [image], videos: [], detailJobId: job.id, moduleId: job.moduleId, generationVersion: job.version || 1 });
        ids.add(id);
      }
      job.workArchivedAt = timestamp;
      reference.workArchivedAt = timestamp;
    }
  }
}
