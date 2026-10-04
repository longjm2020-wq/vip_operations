export function normalizeImageText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+(?=\n)/g, "")
    .replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, "")
    .replace(/(\d)[ \t]+%/g, "$1%")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function imageTextScore(result: { text: string; confidence: number }) {
  const text = normalizeImageText(result.text),
    characters = text.match(/[\p{L}\p{N}]/gu)?.length || 0;
  if (!characters) return -1;
  const noise =
    (text.match(/[^\p{L}\p{N}\s%.,，。:：;；()/（）+\-]/gu)?.length || 0) /
    Math.max(1, text.length);
  return (
    (Number.isFinite(result.confidence) ? result.confidence : 0) +
    Math.min(12, characters / 20) -
    noise * 40
  );
}

/** Only replace a doubtful line when recognition of the same pixels improves. */
export function preferImageTextLine(
  before: { text: string; confidence: number },
  candidate: { text: string; confidence: number },
) {
  const text = normalizeImageText(candidate.text);
  const characters = (value: string) =>
    value.match(/[\p{L}\p{N}]/gu)?.length || 0;
  return (
    candidate.confidence >= 45 &&
    !text.includes("\n") &&
    characters(text) >= Math.max(3, characters(before.text) * 0.55) &&
    imageTextScore(candidate) > imageTextScore(before) + 12
  );
}

/** Normalize local illumination without thresholding away thin Chinese strokes. */
export function enhanceTextImage(source: HTMLCanvasElement) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d")!,
    original = source
      .getContext("2d")!
      .getImageData(0, 0, source.width, source.height);
  const { width, height, data } = original,
    stride = width + 1;
  const gray = new Uint8Array(width * height),
    integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x,
        offset = pixel * 4;
      gray[pixel] = Math.round(
        data[offset] * 0.299 +
          data[offset + 1] * 0.587 +
          data[offset + 2] * 0.114,
      );
      rowSum += gray[pixel];
      integral[(y + 1) * stride + x + 1] =
        integral[y * stride + x + 1] + rowSum;
    }
  }
  const radius = Math.max(16, Math.round(Math.min(width, height) / 35));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius),
        right = Math.min(width, x + radius + 1),
        top = Math.max(0, y - radius),
        bottom = Math.min(height, y + radius + 1);
      const mean =
        (integral[bottom * stride + right] -
          integral[top * stride + right] -
          integral[bottom * stride + left] +
          integral[top * stride + left]) /
        ((right - left) * (bottom - top));
      const value = Math.max(
        0,
        Math.min(255, 245 + (gray[y * width + x] - mean) * 2),
      );
      const offset = (y * width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  context.putImageData(original, 0, 0);
  return canvas;
}
