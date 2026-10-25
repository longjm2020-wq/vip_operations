// Bind generation to the inputs used to compile its B/C files, not a later UI save.
import { selectedCast } from "../shared/project-cast.mjs";
export function referenceSnapshot(project) {
  return structuredClone({
    projectId: project.id,
    assets: project.assets,
    modelMeasurements: project.modelMeasurements,
    productMeasurements: project.productMeasurements,
    ...(project.cast ? { cast: selectedCast(project) } : {}),
    sceneMode: project.sceneMode,
    sceneSelection: project.sceneSelection,
    videoAspectRatio: project.videoAspectRatio,
    resolvedVideoAspectRatio: project.resolvedVideoAspectRatio,
  });
}

export async function generationProject(store, project, artifacts) {
  const snapshot = artifacts?.referenceSnapshot;
  if (snapshot) {
    if (snapshot.projectId !== project.id) throw new Error("编译素材与当前项目不匹配，已阻止跨项目引用。");
    return { ...project, ...structuredClone(snapshot), id: project.id };
  }

  // Older completed jobs already recorded their uploaded asset IDs in their C file.
  // Recover only from this job's own server-generated C file, never an imported template.
  const cFile = artifacts?.cFile;
  if (!cFile) return project;
  const stored = await store.readAsset(cFile.path);
  if (!stored || stored.metadata.projectId !== project.id) return project;
  let body;
  try { body = JSON.parse(stored.buffer.toString("utf8")); } catch { return project; }
  if (body.schema !== "XUTI_C_V1" || !artifacts.sourceFingerprint || body.source_fingerprint !== artifacts.sourceFingerprint) return project;
  const input = body.input_snapshot;
  if (!input?.model_images?.length || !input?.product_images?.length) return project;
  const files = (ids, kind) => (ids || []).map((id) => {
    const metadata = store.getAssetMetadata(id);
    if (!metadata || metadata.kind !== kind || (metadata.projectId && metadata.projectId !== project.id)) {
      throw new Error("编译时使用的素材不可用或归属不匹配，请检查当前项目素材。");
    }
    return { path: id, name: metadata.name, size: metadata.size, kind };
  });
  return { ...project, assets: { ...project.assets,
    modelImages: files(input.model_images, "model"),
    productImages: files(input.product_images, "product"),
    sceneImages: files(input.scene_images, "scene"),
  } };
}
