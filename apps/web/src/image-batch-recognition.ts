import { naturalCompare, type BatchImageItem } from "./image-batch-plan.js";

export type ImagePalette = { color: [number, number, number]; weight: number }[];
const distance = (a: number[], b: number[]) => Math.sqrt((a[0] - b[0]) ** 2 * 0.6 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
function lab(r: number, g: number, b: number): [number, number, number] {
  const linear = (v: number) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const f = (v: number) => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  r = linear(r); g = linear(g); b = linear(b);
  const x = f((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047);
  const y = f(r * 0.2126729 + g * 0.7151522 + b * 0.072175);
  const z = f((r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
/** A small central colour palette; stays on-device and does not read garment labels. */
export function imagePalette(pixels: ArrayLike<number>, width: number, height: number): ImagePalette {
  const bins = new Map<string, { color: number[]; weight: number }>();
  for (let y = Math.floor(height * 0.32); y < height * 0.74; y++) {
    for (let x = Math.floor(width * 0.28); x < width * 0.72; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i + 3] < 128) continue;
      const color = lab(pixels[i], pixels[i + 1], pixels[i + 2]);
      const key = color.map(v => Math.round(v / 10)).join(",");
      const bin = bins.get(key) || { color: [0, 0, 0], weight: 0 };
      const weight = 1 - Math.abs(x / width - 0.5);
      bin.weight += weight; color.forEach((v, axis) => bin.color[axis] += v * weight); bins.set(key, bin);
    }
  }
  const palette: ImagePalette = [];
  for (const bin of [...bins.values()].sort((a, b) => b.weight - a.weight)) {
    const color = bin.color.map(v => v / bin.weight) as [number, number, number];
    const near = palette.find(point => distance(point.color, color) < 13);
    if (near) {
      near.color = near.color.map((v, axis) => (v * near.weight + color[axis] * bin.weight) / (near.weight + bin.weight)) as [number, number, number];
      near.weight += bin.weight;
    } else palette.push({ color, weight: bin.weight });
  }
  const main = palette.sort((a, b) => b.weight - a.weight).slice(0, 6), total = main.reduce((sum, p) => sum + p.weight, 0);
  return main.map(point => ({ color: point.color, weight: point.weight / total }));
}
export function paletteDistance(a: ImagePalette, b: ImagePalette) {
  if (!a.length || !b.length) return Infinity;
  const directed = (left: ImagePalette, right: ImagePalette) => left.reduce((sum, point) => sum + point.weight * Math.min(...right.map(other => distance(point.color, other.color))), 0);
  return (directed(a, b) + directed(b, a)) / 2;
}
const colorAsset = (item: BatchImageItem) => ["carousel", "flat", "listing"].includes(item.kind);
/** Existing folder/name labels win. Unlabelled assets match colour reference images within their own style. */
export function inferImageColorGroups(input: BatchImageItem[]): BatchImageItem[] {
  const items = input.map(item => ({ ...item }));
  const styles = new Map<string, BatchImageItem[]>();
  for (const item of items.filter(colorAsset)) { const key = item.style.toLocaleLowerCase(); const list = styles.get(key) || []; list.push(item); styles.set(key, list); }
  for (const style of styles.values()) {
    const unlabeled = style.filter(item => !item.group && !item.error);
    if (!unlabeled.length) continue;
    const explicitGroups = [...new Set(style.map(item => item.group).filter(Boolean))];
    let references = style.filter(item => item.group && item.palette?.length);
    if (explicitGroups.length === 1 && !style.some(item => item.kind === "flat" && !item.group) && !style.some(item => item.kind === "listing" && !item.group)) {
      unlabeled.forEach(item => { item.group = explicitGroups[0]; item.groupNote = "沿用本款已有颜色组"; }); continue;
    }
    if (!explicitGroups.length) {
      const lists = unlabeled.filter(item => item.kind === "listing" && item.palette?.length);
      const flats = unlabeled.filter(item => item.kind === "flat" && item.palette?.length);
      // Several list/flat assets provide actual image references; counts alone never split carousel images.
      const anchors = (lists.length >= Math.max(2, flats.length) ? lists : flats.length >= 2 ? flats : []).sort((a, b) => naturalCompare(a.sourcePath, b.sourcePath));
      if (!anchors.length) continue;
      // Indistinguishable reference colours are not evidence for additional colour groups.
      if (anchors.some((item, index) => anchors.slice(index + 1).some(other => paletteDistance(item.palette!, other.palette!) < 2))) {
        unlabeled.forEach(item => { item.groupNote = "参考图颜色过于接近，未自动拆分颜色组"; item.groupUncertain = true; }); continue;
      }
      references = anchors;
      anchors.forEach((item, index) => { item.group = `颜色分组文件夹（${index + 1}）`; item.groupNote = "本款颜色参考图"; });
    }
    if (!references.length) continue;
    for (const item of unlabeled.filter(item => !item.group)) {
      if (!item.palette?.length) { item.groupNote = "未能读取颜色特征"; continue; }
      const scores = new Map<string, number>();
      for (const ref of references) scores.set(ref.group, Math.min(scores.get(ref.group) ?? Infinity, paletteDistance(item.palette, ref.palette!)));
      const ranked = [...scores].sort((a, b) => a[1] - b[1]);
      const [group, best] = ranked[0];
      if (best > 25 || (ranked.length > 1 && ranked[1][1] - best < 1.5)) { item.groupNote = "颜色接近或画面差异较大，保留待确认"; continue; }
      item.group = group; item.groupNote = "按本款图片颜色特征自动匹配";
    }
  }
  return items;
}
