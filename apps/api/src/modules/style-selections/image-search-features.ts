import sharp, { type Metadata } from "sharp";

const maximumPixels = 16_000_000;
const size = 64;
type RegionFeature = { hash: Uint8Array; colors: number[]; edges: number[]; spatial: Float32Array; spatialStats: Float64Array };
export type SelectionImageFeatures = { variants: RegionFeature[][] };
export const selectionImageFeatureVersion = 2;

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

type Pixels = { rgb: Buffer; gray: Float64Array; integral: Float64Array[] };
const stride = size + 1, spatialSize = 32, spatialBlock = 4, blockSamples = spatialBlock * spatialBlock;
function pixelPlanes(rgb: Buffer): Pixels {
  const gray = new Float64Array(size * size), integral = Array.from({ length: 4 }, () => new Float64Array(stride * stride));
  for (let y = 0; y < size; y++) {
    let rTotal = 0, gTotal = 0, bTotal = 0, grayTotal = 0;
    for (let x = 0; x < size; x++) {
      const pixel = y * size + x, offset = pixel * 3;
      const r = rgb[offset], g = rgb[offset + 1], b = rgb[offset + 2], value = r * 0.299 + g * 0.587 + b * 0.114;
      gray[pixel] = value;
      const here = (y + 1) * stride + x + 1, above = y * stride + x + 1;
      integral[0][here] = integral[0][above] + (rTotal += r);
      integral[1][here] = integral[1][above] + (gTotal += g);
      integral[2][here] = integral[2][above] + (bTotal += b);
      integral[3][here] = integral[3][above] + (grayTotal += value);
    }
  }
  return { rgb, gray, integral };
}
const rectangleMean = (plane: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
  (plane[y1 * stride + x1] - plane[y0 * stride + x1] - plane[y1 * stride + x0] + plane[y0 * stride + x0]) / ((x1 - x0) * (y1 - y0));

function regionFeature(pixels: Pixels, left: number, top: number, width: number, height: number): RegionFeature {
  const hash = new Uint8Array(128), colors = Array<number>(64).fill(0), edges = Array<number>(8).fill(0);
  const sample = (x: number, y: number, across: number, down: number) => {
    const x0 = left + Math.floor(x * width / across), x1 = left + Math.floor((x + 1) * width / across);
    const y0 = top + Math.floor(y * height / down), y1 = top + Math.floor((y + 1) * height / down);
    return rectangleMean(pixels.integral[3], x0, y0, Math.max(x0 + 1, x1), Math.max(y0 + 1, y1));
  };
  const horizontal = Array.from({ length: 8 }, (_, y) => Array.from({ length: 9 }, (_, x) => sample(x, y, 9, 8)));
  const vertical = Array.from({ length: 9 }, (_, y) => Array.from({ length: 8 }, (_, x) => sample(x, y, 8, 9)));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    hash[y * 8 + x] = horizontal[y][x] > horizontal[y][x + 1] ? 1 : 0;
    hash[64 + y * 8 + x] = vertical[y][x] > vertical[y + 1][x] ? 1 : 0;
  }
  let edgeTotal = 0;
  const colorWeight = 1 / (width * height);
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    const offset = (y * size + x) * 3;
    const r = pixels.rgb[offset] / 85, g = pixels.rgb[offset + 1] / 85, b = pixels.rgb[offset + 2] / 85;
    const r0 = Math.floor(r), g0 = Math.floor(g), b0 = Math.floor(b);
    const r1 = Math.min(3, r0 + 1), g1 = Math.min(3, g0 + 1), b1 = Math.min(3, b0 + 1);
    const rf = r - r0, gf = g - g0, bf = b - b0, rr = 1 - rf, gg = 1 - gf, bb = 1 - bf;
    // Soft histogram bins remain stable across JPEG compression and brightness shifts.
    colors[r0 * 16 + g0 * 4 + b0] += rr * gg * bb * colorWeight;
    colors[r0 * 16 + g0 * 4 + b1] += rr * gg * bf * colorWeight;
    colors[r0 * 16 + g1 * 4 + b0] += rr * gf * bb * colorWeight;
    colors[r0 * 16 + g1 * 4 + b1] += rr * gf * bf * colorWeight;
    colors[r1 * 16 + g0 * 4 + b0] += rf * gg * bb * colorWeight;
    colors[r1 * 16 + g0 * 4 + b1] += rf * gg * bf * colorWeight;
    colors[r1 * 16 + g1 * 4 + b0] += rf * gf * bb * colorWeight;
    colors[r1 * 16 + g1 * 4 + b1] += rf * gf * bf * colorWeight;
    if (x + 1 < left + width && y + 1 < top + height) {
      const position = y * size + x, center = pixels.gray[position], dx = pixels.gray[position + 1] - center, dy = pixels.gray[position + size] - center;
      const magnitude = Math.hypot(dx, dy);
      const angle = (Math.atan2(dy, dx) + Math.PI) % Math.PI;
      edges[Math.min(7, Math.floor(angle / Math.PI * 8))] += magnitude; edgeTotal += magnitude;
    }
  }
  if (edgeTotal) for (let index = 0; index < edges.length; index++) edges[index] /= edgeTotal;
  // Retain where colors and garment details occur. Global histograms alone can
  // mistake shifted stripes or a different neckline for the same garment.
  const grid = new Float32Array(spatialSize * spatialSize * 3);
  for (let y = 0; y < spatialSize; y++) for (let x = 0; x < spatialSize; x++) {
    const x0 = left + Math.floor(x * width / spatialSize), x1 = left + Math.floor((x + 1) * width / spatialSize);
    const y0 = top + Math.floor(y * height / spatialSize), y1 = top + Math.floor((y + 1) * height / spatialSize);
    const offset = (y * spatialSize + x) * 3;
    for (let channel = 0; channel < 3; channel++)
      grid[offset + channel] = rectangleMean(pixels.integral[channel], x0, y0, x1, y1) / 255;
  }
  // Arrange each 4×4 color block contiguously and cache its mean/variance once.
  // Comparing a query with many cached pictures then needs only a dot product.
  const spatial = new Float32Array(grid.length), spatialStats = new Float64Array((spatialSize / spatialBlock) ** 2 * 3 * 2);
  let block = 0;
  for (let y = 0; y < spatialSize; y += spatialBlock) for (let x = 0; x < spatialSize; x += spatialBlock) {
    for (let channel = 0; channel < 3; channel++) {
      const feature = block * 3 + channel, start = feature * blockSamples;
      let sum = 0, square = 0, index = 0;
      for (let yy = y; yy < y + spatialBlock; yy++) for (let xx = x; xx < x + spatialBlock; xx++) {
        const value = grid[(yy * spatialSize + xx) * 3 + channel];
        spatial[start + index++] = value; sum += value; square += value * value;
      }
      const mean = sum / blockSamples;
      spatialStats[feature * 2] = mean;
      spatialStats[feature * 2 + 1] = Math.max(0, square / blockSamples - mean * mean);
    }
    block++;
  }
  return { hash, colors, edges, spatial, spatialStats };
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
  const mirrored = Buffer.allocUnsafe(pixels.length);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const source = (y * size + x) * 3, target = (y * size + size - 1 - x) * 3;
    mirrored[target] = pixels[source]; mirrored[target + 1] = pixels[source + 1]; mirrored[target + 2] = pixels[source + 2];
  }
  const regions = [[0, 0, 64, 64], [8, 6, 48, 52], [16, 10, 32, 42]];
  return { variants: [pixels, mirrored].map(image => {
    const planes = pixelPlanes(image);
    return regions.map(([left, top, width, height]) => regionFeature(planes, left, top, width, height));
  }) };
}

const histogramDistance = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / 2;
function regionDistance(left: RegionFeature, right: RegionFeature) {
  const hash = left.hash.reduce((sum, bit, index) => sum + Number(bit !== right.hash[index]), 0) / left.hash.length;
  const global = hash * 0.52 + histogramDistance(left.colors, right.colors) * 0.36 + histogramDistance(left.edges, right.edges) * 0.12;
  return Math.max(global, spatialDistance(left, right));
}
function spatialDistance(left: RegionFeature, right: RegionFeature) {
  // Standard SSIM constants for samples normalized to [0, 1]. The luminance,
  // contrast and covariance terms retain compression tolerance while comparing
  // local structure. DSSIM = (1 - SSIM) / 2 remains a distance, not a probability.
  const c1 = 0.01 ** 2, c2 = 0.03 ** 2, blocks = (spatialSize / spatialBlock) ** 2;
  const details: number[] = [];
  for (let block = 0; block < blocks; block++) {
    let similarity = 0;
    for (let channel = 0; channel < 3; channel++) {
      const feature = block * 3 + channel, start = feature * blockSamples, stats = feature * 2;
      let product = 0;
      for (let index = start; index < start + blockSamples; index++) product += left.spatial[index] * right.spatial[index];
      const a = left.spatialStats[stats], b = right.spatialStats[stats];
      const va = left.spatialStats[stats + 1], vb = right.spatialStats[stats + 1], covariance = product / blockSamples - a * b;
      similarity += ((2 * a * b + c1) * (2 * covariance + c2)) / ((a * a + b * b + c1) * (va + vb + c2));
    }
    details.push(Math.max(0, Math.min(1, (1 - similarity / 3) / 2)));
  }
  // Average the most changed quarter of local blocks. Matching backgrounds must
  // not dilute a different neckline, pocket or stripe placement into a high score.
  details.sort((a, b) => b - a);
  const changed = details.length / 4;
  let distance = 0;
  for (let index = 0; index < changed; index++) distance += details[index];
  return distance / changed;
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
