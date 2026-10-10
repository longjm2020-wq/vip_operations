import sharp, { type Metadata } from "sharp";

const maximumPixels = 16_000_000;
const size = 64;
type RegionFeature = { hash: Uint8Array; colors: number[]; edges: number[] };
export type SelectionImageFeatures = { variants: RegionFeature[][] };

/** Accept image bytes only; no filename, URL or remote resource enters Sharp. */
export function decodeSelectionSearchImage(data: string, maximumBytes = 500 * 1024): Buffer {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match) throw Error("请选择 JPG、PNG 或 WebP 图片");
  const bytes = Buffer.from(match[2], "base64"), type = match[1];
  const valid = type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : type === "image/jpeg" ? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid || !bytes.length) throw Error("图片格式无效，请选择完整的 JPG、PNG 或 WebP 图片");
  if (bytes.length >= maximumBytes) throw Error(`图片须压缩至 ${Math.round(maximumBytes / 1024)} KB 以下`);
  return bytes;
}

const gray = (pixels: Buffer, x: number, y: number) => {
  const offset = (y * size + x) * 3;
  return pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
};
function regionFeature(pixels: Buffer, left: number, top: number, width: number, height: number): RegionFeature {
  const hash = new Uint8Array(128), colors = Array<number>(64).fill(0), edges = Array<number>(8).fill(0);
  const sample = (x: number, y: number, across: number, down: number) => {
    const x0 = left + Math.floor(x * width / across), x1 = left + Math.floor((x + 1) * width / across);
    const y0 = top + Math.floor(y * height / down), y1 = top + Math.floor((y + 1) * height / down);
    let total = 0, count = 0;
    for (let yy = y0; yy < Math.max(y0 + 1, y1); yy++) for (let xx = x0; xx < Math.max(x0 + 1, x1); xx++) {
      total += gray(pixels, Math.min(size - 1, xx), Math.min(size - 1, yy)); count++;
    }
    return total / count;
  };
  const horizontal = Array.from({ length: 8 }, (_, y) => Array.from({ length: 9 }, (_, x) => sample(x, y, 9, 8)));
  const vertical = Array.from({ length: 9 }, (_, y) => Array.from({ length: 8 }, (_, x) => sample(x, y, 8, 9)));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    hash[y * 8 + x] = horizontal[y][x] > horizontal[y][x + 1] ? 1 : 0;
    hash[64 + y * 8 + x] = vertical[y][x] > vertical[y + 1][x] ? 1 : 0;
  }
  let edgeTotal = 0;
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    const offset = (y * size + x) * 3;
    const channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2]].map(value => value / 255 * 3);
    // Soft histogram bins remain stable across JPEG compression and brightness shifts.
    for (let r = 0; r < 2; r++) for (let g = 0; g < 2; g++) for (let b = 0; b < 2; b++) {
      const choices = [r, g, b];
      const bins = channels.map((value, index) => Math.min(3, Math.floor(value) + choices[index]));
      const weight = channels.reduce((product, value, index) => product * (choices[index] ? value % 1 : 1 - value % 1), 1);
      colors[bins[0] * 16 + bins[1] * 4 + bins[2]] += weight / (width * height);
    }
    if (x + 1 < left + width && y + 1 < top + height) {
      const center = gray(pixels, x, y), dx = gray(pixels, x + 1, y) - center, dy = gray(pixels, x, y + 1) - center;
      const magnitude = Math.hypot(dx, dy);
      const angle = (Math.atan2(dy, dx) + Math.PI) % Math.PI;
      edges[Math.min(7, Math.floor(angle / Math.PI * 8))] += magnitude; edgeTotal += magnitude;
    }
  }
  if (edgeTotal) for (let index = 0; index < edges.length; index++) edges[index] /= edgeTotal;
  return { hash, colors, edges };
}

export async function createSelectionImageFeatures(bytes: Buffer): Promise<SelectionImageFeatures> {
  const options = { failOn: "warning" as const, limitInputPixels: maximumPixels, pages: 1 };
  let metadata: Metadata;
  try { metadata = await sharp(bytes, options).metadata(); }
  catch (error) {
    if (/pixel limit/i.test(String(error))) throw Error("图片尺寸超过 1600 万像素，请缩小后重试");
    throw Error("图片无法解码，请选择完整的 JPG、PNG 或 WebP 图片");
  }
  if (!["jpeg", "png", "webp"].includes(metadata.format || "")) throw Error("请选择 JPG、PNG 或 WebP 图片");
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > maximumPixels) throw Error("图片尺寸超过 1600 万像素，请缩小后重试");
  if ((metadata.pages || 1) > 1) throw Error("请使用静态图片，暂不支持动画图片搜索");
  let pixels: Buffer;
  try {
    pixels = await sharp(bytes, options).rotate().flatten({ background: "#ffffff" }).resize(size, size, { fit: "fill" })
      .toColourspace("srgb").removeAlpha().raw().timeout({ seconds: 2 }).toBuffer();
  } catch { throw Error("图片无法解码或处理超时，请换一张较小的图片重试"); }
  const mirrored = Buffer.alloc(pixels.length);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    pixels.copy(mirrored, (y * size + size - 1 - x) * 3, (y * size + x) * 3, (y * size + x) * 3 + 3);
  const regions = [[0, 0, 64, 64], [8, 6, 48, 52], [16, 10, 32, 42]];
  return { variants: [pixels, mirrored].map(image => regions.map(([left, top, width, height]) => regionFeature(image, left, top, width, height))) };
}

const histogramDistance = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / 2;
function regionDistance(left: RegionFeature, right: RegionFeature) {
  const hash = left.hash.reduce((sum, bit, index) => sum + Number(bit !== right.hash[index]), 0) / left.hash.length;
  return hash * 0.52 + histogramDistance(left.colors, right.colors) * 0.36 + histogramDistance(left.edges, right.edges) * 0.12;
}
/** A ranking distance, not a probability or a claim that two garments are identical. */
export function selectionImageDistance(left: SelectionImageFeatures, right: SelectionImageFeatures): number {
  let best = 1;
  for (const leftVariant of left.variants) for (const rightVariant of right.variants) {
    const distances = leftVariant.map((region, index) => regionDistance(region, rightVariant[index]));
    best = Math.min(best, distances[0] * 0.3 + distances[1] * 0.4 + distances[2] * 0.3);
  }
  return best;
}
