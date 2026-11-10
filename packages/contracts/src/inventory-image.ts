import { z } from "zod";

export const inventoryImageLimit = 500 * 1024;
export const inventoryImageBatchSize = 8;
const productId = z.string().regex(/^[1-9]\d{0,18}$/);
/** '' means the whole style. A color row stores its own picture. */
export const inventoryImageColor = z
  .string()
  .trim()
  .max(64)
  .refine((value) => value !== "多颜色", "汇总含多种颜色时不能上传颜色图片")
  .default("");
const data = z.string().max(1_500_000);
const fileName = z.string().trim().max(255).optional();

export const inventoryImageWriteSchema = z
  .object({ productId, colorName: inventoryImageColor, data, fileName })
  .strict();
export const inventoryImageDeleteSchema = z
  .object({ productId, colorName: inventoryImageColor })
  .strict();
export const inventoryImageBatchSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            styleNo: z.string().trim().min(1).max(64),
            colorName: inventoryImageColor,
            data: data.optional(),
            /** Excel image links are stored as links; the server never fetches them. */
            url: z.url().max(2048).regex(/^https:\/\//i, "图片链接需为 https 地址").optional(),
            fileName,
            source: z.enum(["batch", "excel"]).default("batch"),
          })
          .strict()
          .refine((item) => !!item.data !== !!item.url, "每张图片需提供文件或链接其中一项"),
      )
      .min(1)
      .max(inventoryImageBatchSize),
  })
  .strict();
export type InventoryImageBatchResult = {
  styleNo: string;
  colorName: string;
  fileName?: string;
  status: "SAVED" | "NOT_FOUND" | "INVALID";
  message?: string;
};
export type InventoryImageSource = "vip" | "vip-style" | "compass" | "user" | "archive";
export const inventoryImageSourceLabels: Record<InventoryImageSource, string> = {
  vip: "唯品会商品图",
  "vip-style": "唯品会整款图",
  compass: "唯品会罗盘图",
  user: "用户上传",
  archive: "选款登记档案图",
};

const styleFolder = /^[A-Za-z][A-Za-z0-9-]*\d[A-Za-z0-9-]*$/;
const styleFile = /^[A-Za-z0-9][A-Za-z0-9-]{1,63}$/;

/** Match a local file to a style. Accepts `S22X20130.jpg`, `S22X20130_黑色.jpg`
 * and image-batch-naming output `S22X20130/1.jpg` (carousel 1, then list 50,
 * then other carousel numbers; detail 6xx, 30 and 826 tag pages are never
 * chosen). Lower rank wins. Returns null when the file is not usable. */
export function inventoryImageFileTarget(path: string): { styleNo: string; colorName: string; rank: number } | null {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const file = parts.at(-1) ?? "";
  if (!/\.(jpe?g|png|webp)$/i.test(file)) return null;
  const stem = file.replace(/\.[^.]+$/, "").trim();
  const folders = parts.slice(0, -1);
  let styleIndex = -1;
  for (let i = folders.length - 1; i >= 0; i--) if (styleFolder.test(folders[i])) { styleIndex = i; break; }
  if (styleIndex >= 0 && /^\d+$/.test(stem)) {
    const n = Number(stem);
    const rank = n === 1 ? 1 : n === 50 ? 2 : n >= 2 && n <= 22 ? 3 + n : NaN;
    if (Number.isNaN(rank)) return null;
    // Pictures in colour sub-folders rank after those directly in the style folder.
    return { styleNo: folders[styleIndex], colorName: "", rank: rank + (folders.length - 1 - styleIndex) * 100 };
  }
  const [style, ...color] = stem.split(/[_＿]/);
  const styleNo = style.trim();
  if (!styleFile.test(styleNo) || /^\d+$/.test(styleNo)) return null;
  return { styleNo, colorName: color.join("_").trim().slice(0, 64), rank: 0 };
}

/** Pick one picture per style/colour from a local selection. */
export function planInventoryImageFiles<T extends { path: string }>(files: readonly T[]) {
  const chosen = new Map<string, { file: T; styleNo: string; colorName: string; rank: number }>();
  const skipped: { file: T; reason: string }[] = [];
  for (const file of files) {
    const target = inventoryImageFileTarget(file.path);
    if (!target) {
      skipped.push({ file, reason: "文件名未识别为款号，或是详情、吊牌、平铺图" });
      continue;
    }
    const key = `${target.styleNo.toUpperCase()}\u0000${target.colorName}`;
    const old = chosen.get(key);
    if (!old || target.rank < old.rank || (target.rank === old.rank && file.path.localeCompare(old.file.path, "zh-CN", { numeric: true }) < 0)) {
      if (old) skipped.push({ file: old.file, reason: "同一款号已选用其他图片" });
      chosen.set(key, { file, ...target });
    } else skipped.push({ file, reason: "同一款号已选用其他图片" });
  }
  return { chosen: [...chosen.values()], skipped };
}
