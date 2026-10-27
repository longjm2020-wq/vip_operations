export const carouselNumbers = [1, 2, 3, 4, 15, 16, 17, 18, 19, 20, 21, 22] as const;
export const imageKindLabels = {
  carousel: "方形轮播图", detail: "详情图", flat: "30 号透明平铺图",
  listing: "50 号商品列表图", certificate: "826 号吊牌合格证图", unknown: "待确认", skip: "跳过",
} as const;
export type ImageKind = keyof typeof imageKindLabels;
export type DirectoryLayout = "auto" | "single" | "batch";
export type ColorFolderMode = "source" | "numbered";
import type { ImagePalette } from "./image-batch-recognition.js";
export interface BatchImageMetadata { width: number; height: number; format: string; transparent: boolean; palette?: ImagePalette }
export interface BatchImageItem extends BatchImageMetadata {
  id: string; sourcePath: string; style: string; group: string; kind: ImageKind; order: number; size: number; error?: string; groupNote?: string; groupUncertain?: boolean;
}
export interface BatchPlanEntry { item: BatchImageItem; target: string; limit?: number }
export interface BatchReviewEntry { item: BatchImageItem; target: string; reasons: string[] }
export interface BatchPlan { entries: BatchPlanEntry[]; review: BatchReviewEntry[]; issues: Record<string, string[]>; styles: number; groups: number; skipped: number }
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
const roleDirectory = /^(?:主图|轮播图?|方图|详情(?:页|图)?|平铺图?|透明图?|列表图?|封面(?:_导出)?|吊牌|合格证|images?|detail|carousel|flat|listing)$/i;
export const outputPrefix = "图片命名结果-";
const outputStyleDirectory = (style: string) => style.replace(/-/g, "X");
export function validFolderName(value: string) {
  return !!value.trim() && value === value.trim() && value.length <= 100 && !/[\\/:*?"<>|\u0000-\u001f]/.test(value)
    && !/[. ]$/.test(value) && !/^(?:\.{1,2}|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(value);
}
export function detectImageKind(path: string, image: BatchImageMetadata): ImageKind {
  const name = path.split("/").at(-1)!.replace(/\.[^.]+$/, "");
  if (/^30$|透明|平铺|(?:^|[_ -])flat(?:[_ -]|$)/i.test(name)) return "flat";
  if (/^50$|列表|(?:^|[_ -])listing(?:[_ -]|$)/i.test(name)) return "listing";
  if (/^826$|吊牌|合格证|certificate/i.test(name)) return "certificate";
  if (/^(?:6[0-4][0-9]|650)$|详情|detail/i.test(name) || path.split("/").slice(0, -1).some(part => /^(详情(?:页|图)?|detail)$/i.test(part))) return "detail";
  if (!image.width || !image.height) return "unknown";
  if (image.width === image.height) return image.transparent ? "flat" : "carousel";
  if (Math.abs(image.width - 640) <= 2 && Math.abs(image.height - 840) <= 2) return "certificate";
  const ratio = image.width / image.height;
  if (Math.abs(ratio - 950 / 1200) <= 0.006) return "listing";
  if (ratio <= 0.78) return "detail";
  return "unknown";
}
function filenameColor(path: string) {
  const name = path.split("/").at(-1)!.replace(/\.[^.]+$/, "");
  const match = name.match(/(?:^|[_\-\s（(])((?:颜色|色组|color)[_-]?\d+)(?=[_\-\s）)]|$)/i);
  if (match) return match[1];
  return name.match(/(?:燕麦色|米白色|深灰色|浅灰色|藏蓝色|宝蓝色|浅咖色|深咖色|咖啡色|奶茶色|焦糖色|黑色|白色|灰色|红色|蓝色|绿色|粉色|紫色|黄色|橙色|咖色|驼色|米白|藏蓝|深灰)/)?.[0] || "";
}
export function assignImageGroups(rootName: string, files: (BatchImageMetadata & { sourcePath: string; size: number; error?: string })[], layout: DirectoryLayout): BatchImageItem[] {
  const hasRootImages = files.some(file => !file.sourcePath.includes("/"));
  const rootIsStyle = /^[a-z][a-z\d_-]*\d[a-z\d_-]*$/i.test(rootName);
  const batch = layout === "batch" || (layout === "auto" && !hasRootImages && !rootIsStyle);
  const items = [...files].sort((a, b) => naturalCompare(a.sourcePath, b.sourcePath)).map((file, index) => {
    const parts = file.sourcePath.split("/");
    const style = batch && parts.length > 1 ? parts.shift()! : rootName;
    const group = parts.slice(0, -1).find(part => !roleDirectory.test(part)) || filenameColor(file.sourcePath);
    return { ...file, id: file.sourcePath, style, group, order: index + 1, kind: file.error ? "unknown" : detectImageKind(file.sourcePath, file) };
  });
  const details = items.filter(item => item.kind === "detail").sort((a, b) => naturalCompare(a.sourcePath.split("/").at(-1)!, b.sourcePath.split("/").at(-1)!) || naturalCompare(a.sourcePath, b.sourcePath));
  details.forEach((item, index) => { item.order = index + 1; });
  return items;
}
export function buildImageBatchPlan(items: BatchImageItem[], folderMode: ColorFolderMode = "source"): BatchPlan {
  const entries: BatchPlanEntry[] = [], issues: Record<string, string[]> = {};
  const addIssue = (item: BatchImageItem, text: string) => { (issues[item.id] ||= []).push(text); };
  const active = items.filter(item => item.kind !== "skip");
  const styles = new Map<string, BatchImageItem[]>();
  for (const item of active) {
    if (item.error) addIssue(item, item.error);
    if (!validFolderName(item.style)) addIssue(item, "款号目录名称无效，请去掉路径符号或末尾空格");
    if (item.kind === "unknown") addIssue(item, "请选择图片用途，或选择跳过");
    if (item.groupUncertain && !item.group && ["carousel", "flat", "listing"].includes(item.kind)) addIssue(item, "颜色无法可靠匹配，原图另存待确认；可手动指定颜色组");
    if (item.group && !validFolderName(item.group)) addIssue(item, "颜色组名称无效，请仅填写一个文件夹名称");
    if (!Number.isFinite(item.order) || item.order < 1) addIssue(item, "顺序必须是大于 0 的数字");
    if (item.kind === "carousel" || item.kind === "flat") {
      if (item.width !== item.height) addIssue(item, "轮播图和平铺图必须为正方形，不会自动裁切");
      if (item.kind === "flat" && !item.transparent) addIssue(item, "30 号图须有透明像素，请选择透明图片；本工具不自动抠图");
      if (item.kind === "carousel" && item.transparent) addIssue(item, "轮播图含透明像素，请改为平铺图或准备不透明原图");
    } else if (["detail", "listing", "certificate"].includes(item.kind)) {
      if (item.width >= item.height) addIssue(item, "此用途需要竖向矩形图片");
    }
    const key = item.style.toLocaleLowerCase();
    const list = styles.get(key) || []; list.push(item); styles.set(key, list);
  }
  // Distinct source styles must not be merged when their output names normalize to the same directory.
  const outputStyles = new Map<string, BatchImageItem[][]>();
  for (const styleItems of styles.values()) {
    const key = outputStyleDirectory(styleItems[0].style).toLocaleLowerCase();
    const list = outputStyles.get(key) || []; list.push(styleItems); outputStyles.set(key, list);
  }
  for (const matchingStyles of outputStyles.values()) {
    if (matchingStyles.length > 1) for (const item of matchingStyles.flat()) addIssue(item, "款号替换后目录重名，请调整款号目录后再处理");
  }
  let groupCount = 0;
  for (const styleItems of styles.values()) {
    const styleDirectory = outputStyleDirectory(styleItems[0].style);
    const colors = [...new Set(styleItems.filter(item => ["carousel", "flat", "listing"].includes(item.kind)).map(item => item.group).filter(Boolean))].sort(naturalCompare);
    groupCount += colors.length || 1;
    const multiple = colors.length > 1;
    const buckets = new Map<string, BatchImageItem[]>();
    for (const item of styleItems) {
      if (item.kind === "unknown") continue;
      const colorAsset = ["carousel", "flat", "listing"].includes(item.kind);
      if (multiple && colorAsset && !item.group) addIssue(item, "多色款的轮播、30、50 号图必须指定颜色组");
      if (issues[item.id]) continue;
      const group = colorAsset ? item.group || colors[0] || "" : "";
      const folder = multiple && colorAsset ? (folderMode === "source" ? group : `颜色分组文件夹（${colors.indexOf(group) + 1}）`) : "";
      const directory = [styleDirectory, folder].filter(Boolean).join("/");
      const key = `${directory.toLocaleLowerCase()}\0${item.kind}`;
      const bucket = buckets.get(key) || []; bucket.push(item); buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => a.order - b.order || naturalCompare(a.sourcePath, b.sourcePath));
      const kind = bucket[0].kind;
      const maximum = kind === "carousel" ? carouselNumbers.length : kind === "detail" ? 50 : 1;
      if (bucket.length > maximum) for (const item of bucket.slice(maximum)) addIssue(item, `${imageKindLabels[kind]}共 ${bucket.length} 张，超出当前范围 ${maximum} 张的编号上限；多余原图另存待确认`);
      bucket.forEach((item, index) => {
        const colorAsset = ["carousel", "flat", "listing"].includes(kind);
        const group = colorAsset ? item.group || colors[0] || "" : "";
        const folder = multiple && colorAsset ? (folderMode === "source" ? group : `颜色分组文件夹（${colors.indexOf(group) + 1}）`) : "";
        const number = kind === "carousel" ? carouselNumbers[index] : kind === "detail" ? 601 + index : kind === "flat" ? 30 : kind === "listing" ? 50 : 826;
        if (index >= maximum) return;
        entries.push({ item, target: [styleDirectory, folder, `${number}.${kind === "flat" ? "png" : "jpg"}`].filter(Boolean).join("/"), limit: kind === "detail" ? undefined : (kind === "flat" ? 600 : 1024) * 1024 });
      });
    }
  }
  const destinations = new Map<string, BatchImageItem>();
  for (const { item, target } of entries) {
    const key = target.toLocaleLowerCase();
    if (destinations.has(key)) { addIssue(item, "输出文件名重复"); addIssue(destinations.get(key)!, "输出文件名重复"); }
    destinations.set(key, item);
  }
  const review = active.filter(item => issues[item.id]).map(item => ({ item, target: `_待确认/${item.sourcePath}`, reasons: issues[item.id] }));
  return { entries: entries.filter(entry => !issues[entry.item.id]), review, issues, styles: styles.size, groups: groupCount, skipped: items.length - active.length };
}
