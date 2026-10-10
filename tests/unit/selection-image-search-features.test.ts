import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createSelectionImageFeatures,
  decodeSelectionSearchImage,
  selectionImageDistance,
} from "../../apps/api/src/modules/style-selections/image-search-features.js";

const dataUrl = (bytes: Buffer, type = "png") => `data:image/${type};base64,${bytes.toString("base64")}`;
const garment = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320" viewBox="0 0 240 320">
  <rect width="240" height="320" fill="#ddd8cf"/>
  <path d="M71 49L93 35H145L167 49L213 129L176 150L156 111L161 279H77L81 111L61 150L25 129Z" fill="#38281e"/>
  <path d="M93 35L119 84L145 35L133 119H106Z" fill="#a77949"/>
  <path d="M119 84V277M88 126V251M150 126V251" stroke="#d4ba94" stroke-width="4"/>
  <rect x="93" y="168" width="13" height="38" fill="#19130d"/>
  <circle cx="124" cy="125" r="4" fill="#e8c997"/>
  <circle cx="124" cy="153" r="4" fill="#e8c997"/>
</svg>`);
const differentPattern = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320">
  <rect width="240" height="320" fill="#e0f5ff"/>
  <path d="M0 30H240M0 80H240M0 130H240M0 180H240M0 230H240M0 280H240" stroke="#005dac" stroke-width="26"/>
  <circle cx="120" cy="160" r="73" fill="#e43330"/>
</svg>`);

let original: Buffer, resizedJpeg: Buffer, mirrored: Buffer, unrelated: Buffer;
beforeAll(async () => {
  [original, unrelated] = await Promise.all([
    sharp(garment).png().toBuffer(),
    sharp(differentPattern).png().toBuffer(),
  ]);
  [resizedJpeg, mirrored] = await Promise.all([
    sharp(original).resize(90, 120).jpeg({ quality: 45 }).toBuffer(),
    sharp(original).flop().webp({ quality: 65 }).toBuffer(),
  ]);
});

describe("selection image query decoding", () => {
  it("accepts valid PNG, JPEG and WebP bytes without changing their contents", () => {
    expect(decodeSelectionSearchImage(dataUrl(original))).toEqual(original);
    expect(decodeSelectionSearchImage(dataUrl(resizedJpeg, "jpeg"))).toEqual(resizedJpeg);
    expect(decodeSelectionSearchImage(dataUrl(mirrored, "webp"))).toEqual(mirrored);
  });

  it("rejects remote URLs, unsupported media, malformed base64 and disguised image types", () => {
    for (const invalid of [
      "https://example.test/image.png",
      "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      "data:image/png;base64,not-base64!",
      "data:image/png;base64,",
      dataUrl(Buffer.from("<html>not an image</html>")),
      dataUrl(original, "jpeg"),
      dataUrl(resizedJpeg, "webp"),
    ]) expect(() => decodeSelectionSearchImage(invalid)).toThrow();
  });

  it("enforces the decoded byte limit before image processing", () => {
    expect(decodeSelectionSearchImage(dataUrl(original), original.length + 1)).toEqual(original);
    expect(() => decodeSelectionSearchImage(dataUrl(original), original.length)).toThrow();
    expect(() => decodeSelectionSearchImage(dataUrl(original), original.length - 1)).toThrow();
  });
});

describe("selection image visual ranking", () => {
  it("ranks a compressed, resized version ahead of a visibly unrelated pattern", async () => {
    const [query, resized, different] = await Promise.all([
      createSelectionImageFeatures(original),
      createSelectionImageFeatures(resizedJpeg),
      createSelectionImageFeatures(unrelated),
    ]);
    const sameDistance = selectionImageDistance(query, query);
    const resizedDistance = selectionImageDistance(query, resized);
    const differentDistance = selectionImageDistance(query, different);
    expect(sameDistance).toBe(0);
    expect(resizedDistance).toBeLessThan(differentDistance);
    expect(resizedDistance).toBeLessThanOrEqual(0.36);
    for (const distance of [sameDistance, resizedDistance, differentDistance]) {
      expect(Number.isFinite(distance)).toBe(true);
      expect(distance).toBeGreaterThanOrEqual(0);
      expect(distance).toBeLessThanOrEqual(1);
    }
  });

  it("recognizes a horizontally mirrored image after lossy encoding", async () => {
    const [query, flipped, different] = await Promise.all([
      createSelectionImageFeatures(original),
      createSelectionImageFeatures(mirrored),
      createSelectionImageFeatures(unrelated),
    ]);
    expect(selectionImageDistance(query, flipped)).toBeLessThan(selectionImageDistance(query, different));
    expect(selectionImageDistance(query, flipped)).toBeLessThanOrEqual(0.36);
  });

  it("refuses unreadable image bytes and images above the pixel limit", async () => {
    await expect(createSelectionImageFeatures(Buffer.from("broken image"))).rejects.toThrow();
    const oversized = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "#fff" } }).png().toBuffer();
    await expect(createSelectionImageFeatures(oversized)).rejects.toThrow();
  });
});
