import { normalizeProductLocks } from "./product-truth.mjs";
import { generationProject } from "./project-references.mjs";
import { referenceEntries } from "./consistency.mjs";
import { normalizeUnitCast, selectedCast } from "../shared/project-cast.mjs";

export const FIDELITY_VERSION = "fidelity-review-v1";
const views = { back: /背面|背部|后背|back/i, inside: /内里|内侧|里衬|inside|lining/i, side: /侧面|侧部|side/i, front: /正面|前片|front/i };
const positiveViews = text => {
  // Legacy scripts: only unambiguous, affirmative exposures. A turn of the
  // head, or an explicit prohibition, is not evidence of a rear garment shot.
  const sentences = String(text || "").split(/[。；;\n]/).filter(s => !/禁止|不得|避免|不要|不展示|不露|勿|\b(no|not|avoid|never)\b/i.test(s));
  return sentences.flatMap(s => [
    /展示背面|背面特写|背对镜头|背部朝向镜头|背面展示|\bback view\b|\bback to (the )?camera\b/i.test(s) ? "back" : "",
    /展示内里|内里特写|翻开.*里衬|\bshow.*lining\b/i.test(s) ? "inside" : "",
  ].filter(Boolean));
};

export function fidelityIssues(project, units, productLock) {
  const locks = normalizeProductLocks(productLock, project);
  const issues = [];
  for (const [index, lock] of locks.entries()) {
    if (lock.classification === "unresolved") issues.push({ code: "ownership", indices: [index], message: `${lock.feature}：归属或来源尚未确认，请对照原图核对，不自动保留或删除。` });
    if (lock.certainty !== "confirmed") continue;
    const key = l => [l.product_id, l.feature, l.view || "", l.region || ""].join("|");
    const other = locks.findIndex((l, i) => i < index && l.certainty === "confirmed" && key(l) === key(lock) && (l.value !== lock.value || l.classification !== lock.classification || (l.anchor && lock.anchor && l.anchor !== lock.anchor) || (l.relation && lock.relation && l.relation !== lock.relation)));
    if (other >= 0) issues.push({ code: "conflict", indices: [other, index], message: `${lock.feature}：同一位置有互相矛盾的观察，请按原图统一后再生成。` });
  }
  for (const unit of units || []) for (const shot of unit.shot_plan?.length ? unit.shot_plan : [unit]) {
    const productIds = normalizeUnitCast(project, shot.product_ids ? shot : unit).product_ids;
    const required = [...(shot.required_product_views || []), ...positiveViews(`${shot.camera || ""};${shot.action || ""}`)];
    const indices = locks.flatMap((lock, index) => lock.certainty !== "confirmed" && (!productIds || productIds.includes(lock.product_id)) && required.some(view => views[view]?.test(`${lock.feature} ${lock.view} ${lock.region}`)) ? [index] : []);
    if (indices.length) issues.push({ code: "missing_view", unitId: unit.id, indices, message: `${unit.id} 要展示尚无可靠依据的商品区域。请补充原图并重新编译，或根据已有原图完成核对；不能用改款或遮挡解决。` });
    // A missing observation must not be interpreted as positive rear/lining
    // evidence. Front-only photos cannot justify inventing an unseen reverse.
    const products = selectedCast(project).products.filter(p => !productIds || productIds.includes(p.id));
    for (const view of [...new Set(required)].filter(v => ["back", "inside"].includes(v))) for (const product of products) {
      if (!locks.some(l => l.product_id === product.id && l.certainty === "confirmed" && l.classification !== "excluded_artifact" && views[view].test(`${l.view} ${l.region} ${l.feature}`))) {
        issues.push({ code: "missing_view", unitId: unit.id, indices: [], message: `${unit.id} 的「${product.name}」缺少${view === "back" ? "背面" : "内里"}原图观察。请补充对应商品原图并重新编译，不能把未记录当作已确认。` });
      }
    }
  }
  return [...new Map(issues.map(issue => [[issue.code, issue.unitId || "", issue.message].join("|"), issue])).values()];
}

export function assertFidelity(project, units, productLock) {
  const issues = fidelityIssues(project, units, productLock);
  if (issues.length) throw new Error(`素材待核对：${issues[0].message} 请打开任务的“智能核对”。未提交新的付费生成。`);
}

// Read-only evidence view. Only VisualReviewService can approve generation.
export class FidelityService {
  constructor(store, visual) { this.store = store; this.visual = visual; }
  async view(id) {
    const job = this.store.getJob(id);
    if (!job || job.type !== "generate") throw new Error("未找到视频任务");
    const task = this.store.getTasks().find(t => t.id === id);
    const project = this.store.getAppState().projects.find(p => p.id === job.projectId);
    if (!task || !project) throw new Error("任务或项目已删除");
    const refs = await generationProject(this.store, project, job.payload.artifacts);
    return {
      locks: normalizeProductLocks(job.payload.artifacts.productLock, refs),
      automatic: this.visual.summary(job, refs),
      canStartAutomatic: job.status === "paused" && !job.providerRequestId && !job.payload.videoSubmission && !job.payload.keyframeGate?.frames.some(f => f.requestId || f.submission),
      references: referenceEntries(refs).filter(e => this.store.getAssetMetadata(e.file.path)).map(e => ({ kind: e.kind, index: e.index, ownerId: e.ownerId, file: e.file, label: e.label })),
      videos: (task.outputFiles || []).filter(f => f.mime?.startsWith("video/") || /\.mp4$/i.test(f.name)),
    };
  }
}
