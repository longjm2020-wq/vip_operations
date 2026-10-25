import { lockedVideoPrompt } from "./keyframe-contract.mjs";
import { CONSISTENCY_NEGATIVES, CONSISTENCY_RULES, referenceEntries, sourceReferenceText, unitProductLock } from "./consistency.mjs";
import { normalizeUnitCast, selectedCast } from "../shared/project-cast.mjs";
import { findScene } from "../shared/scene-catalog.mjs";
import { viewPolicyText } from "./product-view-policy.mjs";
import { mediaReferenceInstructions } from "./media-references.mjs";
import { modelRoleBinding } from "./video-role-binding.mjs";

export const VIDEO_PROMPT_VERSION = "fidelity-budget-v5-model-cast";

// Full and compact requests share exactly the same visual fidelity rules.
// Only repeated scene/camera wording may be factored into reversible notation.
const RULES = CONSISTENCY_RULES;
const clean = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const unique = values => [...new Set(values.map(clean).filter(Boolean))];
const size = prompt => ({ chars: Array.from(prompt).length, bytes: Buffer.byteLength(prompt, "utf8") });
const fits = (prompt, model) => {
  const { chars, bytes } = size(prompt);
  return (!model.maxPromptChars || chars <= model.maxPromptChars) && (!model.maxPromptBytes || bytes <= model.maxPromptBytes);
};
const measures = fields => (fields || []).filter(f => String(f.value ?? "").trim()).map(f => `${f.label}=${f.value}${f.unit || ""}`).join(";");

// A reversible glossary shortens repeated camera phrases without deleting or
// rewriting their meaning. The supplied definitions remain inside the prompt.
export function videoPromptNotation(prompt, phrases) {
  let body = prompt;
  const notation = {};
  for (const phrase of unique(phrases).sort((a, b) => b.length - a.length)) {
    const count = body.split(phrase).length - 1;
    let index = Object.keys(notation).length + 1, label;
    do { label = `K${String(index++).padStart(2, "0")}`; } while (prompt.includes(label) || Object.hasOwn(notation, label));
    const definition = `${label}=${phrase}`;
    if (count < 2 || (Buffer.byteLength(phrase) - label.length) * count <= Buffer.byteLength(definition) + 10) continue;
    body = body.replaceAll(phrase, label);
    notation[label] = phrase;
    if (Object.keys(notation).length >= 20) break;
  }
  if (!Object.keys(notation).length) return { prompt, notation };
  return { prompt: `镜位缩写:${Object.entries(notation).map(([label, phrase]) => `${label}=${phrase}`).join(";")}\n${body}`, notation };
}

function compactParts(project, unit, frameIndex, productLock, model, hasReviewedFrame) {
  const firstFrame = model.inputMode === "first-frame";
  const cast = selectedCast(project), binding = normalizeUnitCast(project, unit);
  const roles = cast.roles.filter(r => !binding.character_ids || binding.character_ids.includes(r.id));
  const products = cast.products.filter(p => !binding.product_ids || binding.product_ids.includes(p.id));
  const aliases = new Map([...cast.roles.map((r, i) => [r.id, `R${i + 1}`]), ...cast.products.map((p, i) => [p.id, `P${i + 1}`])]);
  const alias = id => aliases.get(id) || id;
  const text = value => {
    let result = clean(value);
    // UUID-style IDs in prose can be abbreviated; never replace short IDs such
    // as "a", which can also occur inside unrelated words.
    for (const [id, label] of aliases) if (id.length >= 12) result = result.replaceAll(id, label);
    return firstFrame ? sourceReferenceText(project, result) : result;
  };
  const entries = referenceEntries(project);
  const images = (kind, id) => entries.filter(e => e.kind === kind && e.ownerId === id).map(e => `<IMAGE_${e.index}>`).join(",");
  const mapping = [
    ...roles.map(r => `${alias(r.id)}(${r.name}):${firstFrame ? "首帧中对应人物" : `人物=${images("identity", r.id)}`} ${measures(r.measurements)}`),
    ...products.map(p => `${alias(p.id)}(${p.name})->${alias(p.roleId)}:${firstFrame ? "首帧中对应商品" : `商品=${images("product", p.id)}`} ${measures(p.measurements)}`),
    ...(!firstFrame ? entries.filter(e => e.kind === "scene").map(e => `<IMAGE_${e.index}>=仅场景/光线`) : []),
    !firstFrame && hasReviewedFrame ? `<IMAGE_${frameIndex}>=已验收首帧；商品原图优先` : "",
  ].filter(Boolean).map(text).join("\n");
  const shots = Array.isArray(unit.shot_plan) && unit.shot_plan.length && unit.shot_plan.every(shot => Number.isFinite(shot.start_s) && Number.isFinite(shot.end_s) && shot.end_s > shot.start_s && clean(shot.camera) && clean(shot.action)) ? unit.shot_plan : null;
  const offsets = Array.from((unit.grok_prompt || "").matchAll(/\[([\d.]+)s[–-][\d.]+s\] Continue this action from ([\d.]+)s/g), match => ({ start: Number(match[1]), offset: Number(match[2]) }));
  const castText = shot => [Array.isArray(shot.character_ids) ? `人:${shot.character_ids.map(alias).join(",") || "无"}` : "", Array.isArray(shot.product_ids) ? `款:${shot.product_ids.map(alias).join(",") || "无"}` : ""].filter(Boolean).join(";");
  const defaultCast = shots && shots.every(shot => castText(shot) === castText(shots[0])) ? castText(shots[0]) : "";
  const dictionary = [], references = new Map();
  // Repeated scene/camera descriptions are defined once, with exact text.
  for (const [field, prefix] of [["scene", "景"], ["camera", "机"]]) {
    const counts = new Map();
    for (const shot of shots || []) { const value = text(shot[field]); if (value) counts.set(value, (counts.get(value) || 0) + 1); }
    let index = 0;
    for (const [value, count] of counts) if (count > 1 && Buffer.byteLength(value) > 12) {
      const label = `${prefix}${++index}`;
      references.set(`${field}:${value}`, label);
      dictionary.push(`${label}=${value}`);
    }
  }
  const description = (shot, field, prefix) => {
    const value = text(shot[field]);
    return value ? references.get(`${field}:${value}`) || `${prefix}:${value}` : "";
  };
  const transition = (shot, index) => {
    if (!shot.continuation) return index ? "切镜" : "开场";
    const offset = offsets.find(item => Math.abs(item.start - shot.start_s) < .01)?.offset;
    return offset === undefined ? "续接当前动作勿重启" : `续接源镜头${offset}秒勿重启`;
  };
  const timeline = shots ? shots.map((shot, index) => [
    `${shot.start_s}-${shot.end_s}s${transition(shot, index)}`,
    defaultCast ? "" : castText(shot),
    description(shot, "camera", "机"), description(shot, "action", "动"), description(shot, "scene", "景"),
  ].filter(Boolean).join(";")).join("\n") : text(unit.grok_prompt);
  const scene = project.sceneMode === "keywords" ? findScene(project.sceneSelection?.sceneId) : null;
  if (project.sceneMode === "keywords" && !scene) throw new Error("请选择要写入脚本的场景关键词");
  const locks = unitProductLock(project, unit, productLock, { firstFrame });
  // Every evidence-backed anchor and accessory/exclusion must survive every
  // budget level. Images supplement these constraints; they cannot replace them.
  const criticalLocks = products.flatMap(p => {
    const unknown = unique(locks.filter(l => l.product_id === p.id && (l.certainty !== "confirmed" || l.classification === "unresolved")).map(l => unique([l.feature, l.view, l.region]).join("/") + (l.classification === "unresolved" ? "（归属待核对，不得擅自增删）" : "")));
    return unknown.length ? [`${alias(p.id)} unknown:${unknown.join(",")}；不得臆造或擅改`] : [];
  });
  const observations = unique(locks.filter(l => l.certainty === "confirmed" && l.classification !== "unresolved").map(l =>
    `${alias(l.product_id)}:${l.feature}${l.classification === "excluded_artifact" ? "排除" : ""}=${l.value};${unique([l.view, l.region, l.anchor, l.relation]).join(";")}${l.classification === "bundled_accessory" ? ";原配类型材质数量连接须保留" : ""}`));
  const negatives = unique((unit.negative_constraints || []).filter(n => !CONSISTENCY_NEGATIVES.includes(n)).map(n => typeof n === "string" ? n.replace("源服装排除观察（不得覆盖商品原图）：", "源服装排除：") : n));
  const sections = [
    `${unit.duration_s}s. Follow timed shots/camera/actions/cuts subject to identity/product locks. ${firstFrame ? "唯一输入是已验收首帧，直接开始；原图来源名仅说明出处，旧衣排除不指向首帧商品。" : `Mapped refs only${hasReviewedFrame ? "." : "; no extra frame."}`}`,
    mapping,
    defaultCast ? `全段${defaultCast}` : "",
    scene ? `场景统一覆盖为:${scene.style}/${scene.name};${scene.description}` : "",
    ...dictionary,
    timeline,
    criticalLocks.length ? `待核对/排除:${criticalLocks.join(";")}` : "",
    negatives.length ? `禁项:${negatives.join(";")}` : "",
    firstFrame ? RULES.replace("人物原图逐人锁脸，同组多图是同一人", "各脸沿用已验收首帧") : RULES,
    viewPolicyText(unit),
  ].filter(Boolean).map(text);
  const phrases = unique((shots || []).flatMap(shot => text(shot.camera).split(/[,，;；。]/u))).concat(["中近景正面", "胸口高度", "肩部高度", "中景正面", "轻微向右平移", "轻微拉近", "缓慢推近"]);
  return { sections, observations: observations.map(text), phrases };
}

export function prepareVideoPrompt(project, unit, frameIndex, productLock, model = {}, hasReviewedFrame = true) {
  const mediaInstructions = mediaReferenceInstructions(project);
  const {header,adapt,...roleBinding}=modelRoleBinding(project,unit,model,hasReviewedFrame);
  const bind=text=>adapt([header,text].filter(Boolean).join("\n"));
  const original = bind(lockedVideoPrompt(project, unit, frameIndex, productLock, model.inputMode, hasReviewedFrame) + mediaInstructions);
  const result = (prompt, format, imageBasedObservations = false, notation = {}) => ({ prompt, format, imageBasedObservations, notation, roleBinding, version: VIDEO_PROMPT_VERSION, original: size(original), ...size(prompt) });
  if (fits(original, model)) return result(original, "full");
  const { sections, observations, phrases } = compactParts(project, unit, frameIndex, productLock, model, hasReviewedFrame);
  const compact = bind([...sections, observations.length ? `商品观察（原图优先）:${observations.join(";")}` : "", mediaInstructions].filter(Boolean).join("\n"));
  if (fits(compact, model)) return result(compact, "compact");
  const shorthand = videoPromptNotation(compact, phrases);
  if (fits(shorthand.prompt, model)) return result(shorthand.prompt, "compact", false, shorthand.notation);
  const required = size(shorthand.prompt);
  const limit = [model.maxPromptChars && `${model.maxPromptChars} 字符`, model.maxPromptBytes && `${model.maxPromptBytes} 字节`].filter(Boolean).join(" / ");
  throw new Error(`${model.label || "当前模型"} 的 ${unit.id} 已去除重复说明，完整分镜与必须保留的商品锚点、原配配饰和排除约束仍需 ${required.chars} 字符 / ${required.bytes} 字节，超过 ${limit}；请改用提示词容量更大的模型或人工精简非关键脚本。保真约束未删减，未截断镜头、未提交生成；直接继续不会解决此限制。`);
}
