import sharp from "sharp";
import { z } from "zod";

// Change only the frame policy: source/video receipts keep their cache keys.
export const FRAME_DETAIL_POLICY = "product-detail-v1";
export const DETAIL_DIMENSIONS = [
  { id: "neckline_edges", label: "领口与边饰", inspect: "领口形状、边带宽度、层次、接缝与前后差异；非上装检查对应开口边缘" },
  { id: "ornament_topology", label: "珠饰与扣件拓扑", inspect: "逐种装饰的形状、可见数量/重复规律、连续或离散、连接路径、结点及固定点；波浪珠链绝不能用均匀亮点替代" },
  { id: "pattern_geometry", label: "纹样几何与位置", inspect: "花纹本体、尺度、密度、方向以及相对领口/接缝/腰线的位置，不能把同色近似纹样当作同款" },
  { id: "construction_anchors", label: "结构与穿戴锚点", inspect: "袖口、腰线、系带/扣袋/饰件的连接及固定位置；允许透视和自然褶皱，不允许设计或部位漂移" },
];
export const comparisonSchema = z.object({
  dimension: z.enum(DETAIL_DIMENSIONS.map(d => d.id)),
  reference_observation: z.string().trim().min(3).max(240),
  sample_observation: z.string().trim().min(3).max(240),
  reference_views: z.array(z.string().max(120)).min(1).max(30),
  sample_views: z.array(z.string().max(120)).min(1).max(12),
  visibility: z.enum(["clear", "unclear", "not_in_view", "not_present"]),
  verdict: z.enum(["match", "different", "unclear", "not_applicable"]),
  reason: z.string().trim().min(3).max(240),
});

export function validateDetailComparisons(comparisons, { allowed, sampleIds, views, evidenceImages, citedSamples }) {
  const parsed = z.array(comparisonSchema).length(DETAIL_DIMENSIONS.length).parse(comparisons);
  if (new Set(parsed.map(c => c.dimension)).size !== DETAIL_DIMENSIONS.length) throw new Error("局部核对维度遗漏或重复");
  for (const c of parsed) {
    const originals = c.reference_views.map(id => views.find(v => v.id === id));
    const generated = c.sample_views.map(id => views.find(v => v.id === id));
    if (originals.some(v => !v || v.kind !== "reference" || !allowed.includes(v.imageIndex) || !evidenceImages.includes(v.imageIndex))) throw new Error("局部核对引用了其他商品、生成图或未提供的原图视图");
    if (generated.some(v => !v || v.kind !== "sample" || !sampleIds.includes(v.sampleId) || !citedSamples.includes(v.sampleId))) throw new Error("局部核对引用了未提供的生成视图");
    if (c.visibility === "clear" && !["match", "different"].includes(c.verdict) || ["not_in_view", "not_present"].includes(c.visibility) && c.verdict !== "not_applicable") throw new Error("局部可见性与结论矛盾");
    if (c.verdict === "not_applicable" && !["not_in_view", "not_present"].includes(c.visibility)) throw new Error("可见或模糊的细节不能以不适用放行");
    if (c.visibility === "clear" && c.verdict === "match") {
      // A downscaled montage alone is not sufficient detail evidence when its
      // native crops were supplied. Small full views are already native detail.
      for (const selected of [originals, generated]) {
        if (!selected.some(v => v.crop || v.nativeDetail)) throw new Error("局部通过结论缺少可辨认的细节视图，不能只引用缩小总览");
      }
    }
  }
  // Visibility is independently decisive even if the model also says match.
  if (parsed.every(c => c.verdict === "not_applicable")) return parsed.map(c => ({ ...c, verdict: "unclear", reason: "本帧商品全部关键维度均未得到实际核对，不能按不适用整体放行" }));
  return parsed.map(c => c.visibility === "unclear" && c.verdict !== "different" ? { ...c, verdict: "unclear" } : c);
}

// These are raw-coordinate views, not AI-enhanced images or semantic masks.
// Overlap plus a center view avoids losing details at collage/tile boundaries.
export function detailRectangles(width, height, count = 5) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || Math.min(width, height) < 1) throw new Error("原图尺寸无效");
  if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error("局部视图预算无效");
  const center = [.2, .2, .8, .8], halves = width >= height ? [[0, 0, .6, 1], [.4, 0, 1, 1]] : [[0, 0, 1, .6], [0, .4, 1, 1]];
  const quadrants = [[0, 0, .6, .6], [.4, 0, 1, .6], [0, .4, .6, 1], [.4, .4, 1, 1]];
  const regions = count === 1 ? [center] : count <= 3 ? [...halves, ...(count === 3 ? [center] : [])] : [...quadrants, ...(count === 5 ? [center] : [])];
  return regions.map(([x, y, right, bottom]) => {
    const left = Math.floor(x * width), top = Math.floor(y * height);
    return { left, top, width: Math.ceil(right * width) - left, height: Math.ceil(bottom * height) - top };
  });
}

// A shared budget of 20 product crops, at most five per original. Give every
// product a turn before another photo of the same product. Keep ALL overviews.
export function detailReferenceBudgets(entries) {
  const groups = new Map();
  for (const e of entries.filter(e => e.kind === "product")) groups.set(e.ownerId, [...(groups.get(e.ownerId) || []), e.index]);
  const result = [];
  for (let round = 0; result.length < 20; round++) {
    const next = [...groups.values()].map(ids => ids[round]).filter(Number.isInteger);
    if (!next.length) break;
    result.push(...next.slice(0, 20 - result.length));
  }
  const budgets = new Map(result.map(id => [id, 0]));
  let remaining = 20;
  for (let round = 0; round < 5 && remaining > 0; round++) for (const id of result) {
    if (!remaining) break;
    budgets.set(id, budgets.get(id) + 1); remaining--;
  }
  return budgets;
}

export async function prepareDetailViews(buffer, origin, includeCrops) {
  const meta = await sharp(buffer, { animated: false }).metadata();
  const rotated = [5, 6, 7, 8].includes(meta.orientation);
  const width = rotated ? meta.height : meta.width, height = rotated ? meta.width : meta.height;
  const nativeDetail = Math.max(width, height) <= 1024;
  const full = { ...origin, width, height, nativeDetail };
  const views = [full], images = [];
  if (includeCrops && !nativeDetail) for (const [index, crop] of detailRectangles(width, height, includeCrops === true ? 5 : includeCrops).entries()) {
    // Extract before resize; never enlarge, retouch, sharpen, or invent pixels.
    const output = await sharp(buffer, { animated: false }).rotate().extract(crop)
      .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
    if (output.length > 3 * 1024 * 1024) throw new Error("局部证据超过安全大小，未通过降低细节质量放行");
    const view = { ...origin, id: `${origin.id}:detail-${index + 1}`, crop, width, height };
    views.push(view);
    images.push({ label: `DETAIL ${view.id} · ${origin.kind === "reference" ? `商品原图 IMAGE_${origin.imageIndex}` : `待核对 SAMPLE ${origin.sampleId}`}的实际像素裁切，坐标 ${JSON.stringify(crop)} / ${width}×${height}；不是新原图、不是不同样本`, dataUrl: `data:image/jpeg;base64,${output.toString("base64")}` });
  }
  return { views, images };
}
