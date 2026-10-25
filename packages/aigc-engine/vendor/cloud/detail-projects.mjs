import { fail } from "./access.mjs";
import { isMainImageModule } from "../shared/detail-main-images.mjs";

const active = job => ["pending", "inflight", "submitted"].includes(job.status);
const jobsFor = (data, project) => (project.jobs || []).map(job => data.detailJobs?.[job.id] || job);
const latestJobs = jobs => [...jobs.reduce((map, job) => {
  const previous = map.get(job.moduleId);
  if (!previous || (job.version || 0) >= (previous.version || 0)) map.set(job.moduleId, job);
  return map;
}, new Map()).values()];

export function detailProjectSummary(data, project) {
  const jobs = jobsFor(data, project), latest = latestJobs(jobs);
  const enabled = (project.modules || []).filter(module => module.enabled);
  const completed = enabled.filter(module => latest.some(job => job.moduleId === module.id && job.status === "done")).length;
  const pending = jobs.filter(active).length, uncertain = jobs.filter(job => job.status === "uncertain").length;
  const failed = latest.filter(job => job.status === "failed").length;
  const status = pending ? "generating" : uncertain || failed ? "attention" : enabled.length && completed === enabled.length ? "completed" : completed ? "partial" : enabled.length ? "ready" : "draft";
  const lastOutput = [...jobs].reverse().find(job => job.status === "done" && job.outputAssetId)?.outputAssetId;
  const coverId = lastOutput || project.assets?.product?.[0];
  const cover = data.assets?.[coverId]?.ownerId === project.ownerId ? coverId : undefined;
  const updatedAt = [project.updatedAt, ...jobs.flatMap(job => [job.completedAt, job.createdAt])].filter(Boolean).sort().at(-1);
  return { id: project.id, name: project.name, mode: project.mode, outputTypes: project.outputTypes, createdAt: project.createdAt, updatedAt, version: project.version, deletedAt: project.deletedAt, status, cover, moduleCount: enabled.length, completedCount: completed, activeJobs: pending, uncertainJobs: uncertain };
}

export function listDetailProjectSummaries(store, user, { includeTrash = false } = {}) {
  return Object.values(store.data.detailProjects || {}).filter(project => project.ownerId === user.id && (includeTrash || !project.deletedAt)).map(project => detailProjectSummary(store.data, project)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listDetailTaskRuns(store, user) {
  return Object.values(store.data.detailProjects || {}).filter(project => project.ownerId === user.id && !project.deletedAt).flatMap(project => {
    const jobs = latestJobs(jobsFor(store.data, project)).map(job => {
      const module = project.modules.find(item => item.id === job.moduleId);
      const isMain = module ? isMainImageModule(module) : String(job.moduleId).startsWith("MAIN-") || job.unit?.output_ratio === "1:1";
      const category = ["detail_page", "main_image"].includes(job.outputType) ? job.outputType : isMain ? "main_image" : "detail_page";
      return { id: job.id, moduleId: job.moduleId, name: job.moduleName || module?.name || job.unit?.title || job.moduleId, category, status: job.status, version: job.version, createdAt: job.createdAt, completedAt: job.completedAt, error: job.error, outputAssetId: store.data.assets?.[job.outputAssetId]?.ownerId === user.id ? job.outputAssetId : undefined };
    });
    return ["detail_page", "main_image"].flatMap(category => {
      const items = jobs.filter(job => job.category === category);
      if (!items.length) return [];
      const state = items.some(active) ? "active" : items.some(job => ["failed", "uncertain"].includes(job.status)) ? "failed" : "completed";
      return [{ id: `${project.id}:${category}`, projectId: project.id, name: project.name, category, state, jobs: items, updatedAt: items.map(job => job.completedAt || job.createdAt || project.updatedAt).sort().at(-1) }];
    });
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function assertDetailProjectIdle(data, project) {
  if (jobsFor(data, project).some(job => active(job) || job.status === "uncertain")) fail("项目仍有生成中或待核实的任务，完成处理后再移入回收站", 409);
}

export async function changeDetailProjectState(store, user, id, action) {
  return store.mutate(data => {
    const project = data.detailProjects?.[id];
    if (!project || project.ownerId !== user.id) fail("电商项目不存在", 404);
    const timestamp = new Date().toISOString();
    if (action === "trash") {
      assertDetailProjectIdle(data, project);
      if (!project.deletedAt) {
        project.deletedAt = timestamp;
        for (const work of data.appState.works.filter(work => work.projectId === id && !work.deletedAt)) { work.deletedAt = timestamp; work.projectTrashedAt = timestamp; }
      }
    } else if (action === "untrash") {
      delete project.deletedAt;
      for (const work of data.appState.works.filter(work => work.projectId === id && work.projectTrashedAt)) { delete work.deletedAt; delete work.projectTrashedAt; }
    } else fail("未知项目操作");
    project.updatedAt = timestamp;
    return detailProjectSummary(data, project);
  });
}

export function detailProjectAssetPaths(project) {
  const paths = new Set();
  for (const snapshot of [project, ...(project.versions || []).map(version => version.snapshot)]) {
    for (const ids of Object.values(snapshot?.assets || {})) for (const id of ids) paths.add(id);
    for (const module of snapshot?.modules || []) for (const ids of Object.values(module.asset_bindings || {})) for (const id of ids) paths.add(id);
  }
  for (const job of project.jobs || []) { if (job.outputAssetId) paths.add(job.outputAssetId); for (const id of job.unit?.bound_assets || []) paths.add(id); }
  return paths;
}
