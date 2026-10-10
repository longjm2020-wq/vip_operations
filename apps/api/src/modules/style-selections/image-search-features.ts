import sharp, { type Metadata } from "sharp";

const maximumPixels = 16_000_000;
const size = 64;
type RegionFeature = { hash: Uint8Array; colors: number[]; edges: number[]; spatial: Float32Array; spatialStats: Float64Array };
type SpatialFeature = Pick<RegionFeature, "spatial" | "spatialStats">;
type CaptureFeature = { kind: "center" | "full"; pixels: Buffer; coarse: Float32Array; mean: number; deviation: number; regions: RegionFeature[] };
// The v2 descriptors remain the strict comparison and persisted feedback format.
// Aspect-preserving capture features are transient and never stored as old feedback.
export type SelectionImageFeatures = { variants: RegionFeature[][]; captureVariants?: CaptureFeature[] };
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
  return { hash, colors, edges, ...spatialFeature(pixels, left, top, width, height) };
}
function spatialFeature(pixels: Pixels, left: number, top: number, width: number, height: number): SpatialFeature {
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
  return { spatial, spatialStats };
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
  let pixels: Buffer, capturePixels: Buffer;
  try {
    [pixels, capturePixels] = await Promise.all(["fill", "cover"].map(fit =>
      sharp(bytes, options).rotate().flatten({ background: "#ffffff" }).resize(size, size, { fit: fit as "fill" | "cover" })
        .toColourspace("srgb").removeAlpha().raw().timeout({ seconds: 2 }).toBuffer()));
  } catch { throw Error("图片无法解码或处理超时，请换一张较小的图片重试"); }
  const mirrored = mirrorPixels(pixels), captureMirrored = mirrorPixels(capturePixels);
  const variants = [pixels, mirrored].map(regionFeatures);
  return { variants, captureVariants: [capturePixels, captureMirrored, pixels, mirrored].map((image, index) => {
    const coarse = coarsePixels(image), statistics = coarseStatistics(coarse);
    return { kind: index < 2 ? "center" : "full", pixels: image, coarse, ...statistics, regions: index < 2 ? regionFeatures(image) : variants[index - 2] };
  }) };
}

function mirrorPixels(pixels: Buffer) {
  const mirrored = Buffer.allocUnsafe(pixels.length);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const source = (y * size + x) * 3, target = (y * size + size - 1 - x) * 3;
    mirrored[target] = pixels[source]; mirrored[target + 1] = pixels[source + 1]; mirrored[target + 2] = pixels[source + 2];
  }
  return mirrored;
}
const regions = [[0, 0, 64, 64], [8, 6, 48, 52], [16, 10, 32, 42]];
function regionFeatures(image: Buffer) {
  const planes = pixelPlanes(image);
  return regions.map(([left, top, width, height]) => regionFeature(planes, left, top, width, height));
}

const histogramDistance = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / 2;
function regionDistance(left: RegionFeature, right: RegionFeature) {
  const hash = left.hash.reduce((sum, bit, index) => sum + Number(bit !== right.hash[index]), 0) / left.hash.length;
  const global = hash * 0.52 + histogramDistance(left.colors, right.colors) * 0.36 + histogramDistance(left.edges, right.edges) * 0.12;
  return Math.max(global, spatialDistance(left, right));
}
function spatialDistance(left: SpatialFeature, right: SpatialFeature) {
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
export function selectionImageStrictDistance(left: SelectionImageFeatures, right: SelectionImageFeatures): number {
  let best = 1;
  for (const leftVariant of left.variants) for (const rightVariant of right.variants) {
    const distances = leftVariant.map((region, index) => regionDistance(region, rightVariant[index]));
    best = Math.min(best, distances[0] * 0.3 + distances[1] * 0.4 + distances[2] * 0.3);
  }
  return best;
}

type CaptureTransform = {
  capture: CaptureFeature; scale: number; dx: number; dy: number; angle: number;
  cosine: number; sine: number; coarse: Float32Array; mean: number; deviation: number; penalty: number;
};
const captureTransforms = new WeakMap<SelectionImageFeatures, CaptureTransform[]>();
const captureRefinements = new WeakMap<CaptureTransform, CaptureTransform[]>();
const captureFineRefinements = new WeakMap<CaptureTransform, CaptureTransform[]>();
const captureWarpedPixels = new WeakMap<CaptureTransform, Buffer>();
const captureWarpedSpatial = new WeakMap<CaptureTransform, SpatialFeature[]>();
const captureCacheCounts = new WeakMap<CaptureFeature, Partial<Record<"coarse" | "fine" | "pixels" | "spatial", number>>>();
function cacheCaptureValue<T>(cache: WeakMap<CaptureTransform, T>, transform: CaptureTransform, value: T, kind: "coarse" | "fine" | "pixels" | "spatial") {
  const counts = captureCacheCounts.get(transform.capture) || {}, count = counts[kind] || 0;
  // A query can encounter many different gallery framings. Bound its transient
  // refinement/warp caches instead of retaining every tried alignment.
  if (count < 32) { cache.set(transform, value); counts[kind] = count + 1; captureCacheCounts.set(transform.capture, counts); }
  return value;
}
const sameCaptureTransform = (a: CaptureTransform, b: CaptureTransform) =>
  a.capture === b.capture && a.scale === b.scale && a.dx === b.dx && a.dy === b.dy && a.angle === b.angle;
const center = (size - 1) / 2;
function sourcePosition(x: number, y: number, transform: Pick<CaptureTransform, "scale" | "dx" | "dy" | "cosine" | "sine">) {
  const xx = x - center - transform.dx, yy = y - center - transform.dy;
  return [(xx * transform.cosine + yy * transform.sine) / transform.scale + center,
    (-xx * transform.sine + yy * transform.cosine) / transform.scale + center];
}
function sampleChannel(pixels: Buffer, x: number, y: number, channel: number) {
  x = Math.max(0, Math.min(size - 1, x)); y = Math.max(0, Math.min(size - 1, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(size - 1, x0 + 1), y1 = Math.min(size - 1, y0 + 1);
  const xx = x - x0, yy = y - y0;
  return (pixels[(y0 * size + x0) * 3 + channel] * (1 - xx) + pixels[(y0 * size + x1) * 3 + channel] * xx) * (1 - yy) +
    (pixels[(y1 * size + x0) * 3 + channel] * (1 - xx) + pixels[(y1 * size + x1) * 3 + channel] * xx) * yy;
}
function coarsePixels(pixels: Buffer, transform?: Pick<CaptureTransform, "scale" | "dx" | "dy" | "cosine" | "sine">) {
  const coarse = new Float32Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    // Multiple samples per coarse cell avoid selecting a false alignment when
    // a single sample happens to fall on a narrow stripe or garment edge.
    let luminance = 0;
    for (const yy of [1.5, 5.5]) for (const xx of [1.5, 5.5]) {
      const position = transform ? sourcePosition(x * 8 + xx, y * 8 + yy, transform) : [x * 8 + xx, y * 8 + yy];
      luminance += sampleChannel(pixels, position[0], position[1], 0) * 0.299 +
        sampleChannel(pixels, position[0], position[1], 1) * 0.587 + sampleChannel(pixels, position[0], position[1], 2) * 0.114;
    }
    coarse[y * 8 + x] = luminance / (255 * 4);
  }
  return coarse;
}
function coarseStatistics(coarse: Float32Array) {
  let sum = 0, squares = 0;
  for (const value of coarse) { sum += value; squares += value * value; }
  const mean = sum / coarse.length;
  return { mean, deviation: Math.sqrt(Math.max(0, squares / coarse.length - mean * mean)) };
}
function preparedCaptureTransforms(features: SelectionImageFeatures) {
  let known = captureTransforms.get(features);
  if (known) return known;
  known = [];
  for (const capture of features.captureVariants || []) for (const scale of [0.86, 0.93, 1, 1.075, 1.16])
    for (const dx of [-4, -2, 0, 2, 4]) for (const dy of [-4, -2, 0, 2, 4]) for (const angle of [-3, 0, 3]) {
      const radians = angle * Math.PI / 180, transform = { capture, scale, dx, dy, angle, cosine: Math.cos(radians), sine: Math.sin(radians) };
      const coarse = coarsePixels(capture.pixels, transform);
      known.push({ ...transform, coarse, ...coarseStatistics(coarse),
        penalty: Math.abs(Math.log(scale)) * 0.025 + (Math.abs(dx) + Math.abs(dy)) * 0.0005 + Math.abs(angle) * 0.001 });
    }
  captureTransforms.set(features, known);
  return known;
}
function refinedCaptureTransforms(transform: CaptureTransform) {
  let known = captureRefinements.get(transform);
  if (known) return known;
  known = [];
  for (const xx of [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75]) for (const yy of [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75]) for (const zoom of [-0.02, 0, 0.02]) {
    const dx = transform.dx + xx, dy = transform.dy + yy, scale = transform.scale + zoom;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) continue;
    if (scale < 0.84 || scale > 1.18) continue;
    if (!xx && !yy && !zoom) { known.push(transform); continue; }
    const adjustment = { ...transform, dx, dy, scale }, coarse = coarsePixels(transform.capture.pixels, adjustment);
    known.push({ ...adjustment, coarse, ...coarseStatistics(coarse),
      penalty: Math.abs(Math.log(scale)) * 0.025 + (Math.abs(dx) + Math.abs(dy)) * 0.0005 + Math.abs(transform.angle) * 0.001 });
  }
  return cacheCaptureValue(captureRefinements, transform, known, "coarse");
}
function fineCaptureTransforms(transform: CaptureTransform) {
  const cached = captureFineRefinements.get(transform);
  if (cached) return cached;
  const known: CaptureTransform[] = [];
  for (const xx of [-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15]) for (const yy of [-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15]) {
    const dx = transform.dx + xx, dy = transform.dy + yy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) continue;
    if (!xx && !yy) { known.push(transform); continue; }
    const adjustment = { ...transform, dx, dy }, coarse = coarsePixels(transform.capture.pixels, adjustment);
    known.push({ ...adjustment, coarse, ...coarseStatistics(coarse),
      penalty: Math.abs(Math.log(transform.scale)) * 0.025 + (Math.abs(dx) + Math.abs(dy)) * 0.0005 + Math.abs(transform.angle) * 0.001 });
  }
  return cacheCaptureValue(captureFineRefinements, transform, known, "fine");
}
function warpedCapturePixels(transform: CaptureTransform) {
  const cached = captureWarpedPixels.get(transform);
  if (cached) return cached;
  const image = Buffer.allocUnsafe(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const [sx, sy] = sourcePosition(x, y, transform);
    for (let channel = 0; channel < 3; channel++)
      image[(y * size + x) * 3 + channel] = Math.round(sampleChannel(transform.capture.pixels, sx, sy, channel));
  }
  return cacheCaptureValue(captureWarpedPixels, transform, image, "pixels");
}
function captureDistance(left: SelectionImageFeatures, right: SelectionImageFeatures, strict: number) {
  // Only whole-image transforms are considered. Blocks and garment details may
  // not move independently. Select one transform per framing and orientation:
  // a nearly symmetric garment must retain both mirrored and original alignments.
  if (!right.captureVariants?.length || !left.captureVariants?.length) return strict;
  const targets = new Map(right.captureVariants.filter((_value, index) => index % 2 === 0).map(value => [value.kind, value]));
  const best: { transform: CaptureTransform; target: CaptureFeature; loss: number; gain: number; offset: number }[] = [];
  const consider = (transform: CaptureTransform) => {
    if (best.some(value => sameCaptureTransform(value.transform, transform))) return;
    const target = targets.get(transform.capture.kind);
    if (!target) return;
    const prior = best.find(value => value.transform.capture === transform.capture);
    const gain = Math.max(0.8, Math.min(1.2, target.deviation / Math.max(0.02, transform.deviation)));
    const offset = Math.max(-0.08, Math.min(0.08, target.mean - transform.mean * gain));
    let error = 0, originalExposureError = 0;
    const maximumError = Math.min(0.035, prior?.loss ?? 0.035) * 64;
    for (let index = 0; index < 64; index++) {
      const difference = Math.max(0, Math.min(1, transform.coarse[index] * gain + offset)) - target.coarse[index];
      error += difference * difference;
      const uncorrected = transform.coarse[index] - target.coarse[index];
      originalExposureError += uncorrected * uncorrected;
      if (Math.min(error, originalExposureError) > maximumError) break;
    }
    const loss = Math.min(error, originalExposureError) / 64 + transform.penalty * 0.05;
    if (loss > 0.035 || prior && loss >= prior.loss) return;
    if (prior) best.splice(best.indexOf(prior), 1);
    best.push({ transform, target, loss, gain, offset });
  };
  for (const transform of preparedCaptureTransforms(left)) consider(transform);
  // Refine only the shortlisted coarse alignments. Fractional translation matters
  // for a narrow pocket or stripe, but must remain one global transform.
  const coarseBest = [...best];
  for (const { transform } of coarseBest) for (const refinement of refinedCaptureTransforms(transform)) consider(refinement);
  const refinementBest = [...best];
  for (const { transform } of refinementBest) for (const refinement of fineCaptureTransforms(transform)) consider(refinement);
  // Coarse MSE and detailed local SSIM need not choose the same alignment.
  // Never discard a coarse alignment solely because MSE refinement improved.
  for (const candidate of coarseBest) if (!best.some(value => sameCaptureTransform(value.transform, candidate.transform))) best.push(candidate);
  const aligned = new Set(best.map(value => value.transform));
  // Exposure correction must also examine the unchanged framing, even when
  // background variations make a different coarse transform look preferable.
  for (const transform of preparedCaptureTransforms(left).filter(value => value.scale === 1 && value.dx === 0 && value.dy === 0 && value.angle === 0)) {
    if (best.some(value => sameCaptureTransform(value.transform, transform))) continue;
    const target = targets.get(transform.capture.kind);
    if (!target) continue;
    const gain = Math.max(0.8, Math.min(1.2, target.deviation / Math.max(0.02, transform.deviation)));
    const offset = Math.max(-0.08, Math.min(0.08, target.mean - transform.mean * gain));
    best.push({ transform, target, loss: 0, gain, offset });
  }
  let distance = strict;
  for (const { transform, target, gain, offset } of best) {
    // A new white margin can alter whole-image exposure statistics without
    // changing garment exposure. Preserve an uncorrected comparison for alignment.
    const exposures = aligned.has(transform) && (gain !== 1 || offset !== 0) ? [[gain, offset], [1, 0]] : [[gain, offset]];
    for (const [exposureGain, exposureOffset] of exposures) {
      const originalExposure = exposureGain === 1 && exposureOffset === 0;
      let spatial = originalExposure ? captureWarpedSpatial.get(transform) : undefined;
      if (!spatial) {
        const original = warpedCapturePixels(transform);
        const image = originalExposure ? original : Buffer.allocUnsafe(original.length);
        if (!originalExposure) for (let index = 0; index < original.length; index++)
          image[index] = Math.max(0, Math.min(255, Math.round(original[index] * exposureGain + exposureOffset * 255)));
        const planes = pixelPlanes(image);
        spatial = regions.map(([x, y, width, height]) => spatialFeature(planes, x, y, width, height));
        if (originalExposure) cacheCaptureValue(captureWarpedSpatial, transform, spatial, "spatial");
      }
      // Keep local detail penalties, modestly emphasize the central garment area,
      // and cap tolerance-only scores at 97 so they cannot trigger >=98 focus.
      const exposurePenalty = Math.abs(Math.log(exposureGain)) * 0.02 + Math.abs(exposureOffset) * 0.04;
      const base = 0.03 + transform.penalty + exposurePenalty;
      const local = spatial.map((region, index) => spatialDistance(region, target.regions[index]));
      // Spatial RGB structure remains sensitive to garment details and color,
      // while avoiding hard dHash bit flips from resampling a changed framing.
      // The unmodified strict branch retains its hash, color and edge gates.
      distance = Math.min(distance, base + local[0] * 0.1 + local[1] * 0.3 + local[2] * 0.6);
    }
  }
  return distance;
}

/** Capture tolerance improves ranking only; persisted feedback uses strict v2. */
export function selectionImageDistance(left: SelectionImageFeatures, right: SelectionImageFeatures): number {
  const strict = selectionImageStrictDistance(left, right);
  return strict <= 0.03 ? strict : captureDistance(left, right, strict);
}
