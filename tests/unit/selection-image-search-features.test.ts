import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createSelectionImageFeatures,
  decodeSelectionSearchImage,
  selectionImageFeatureVersion,
  selectionImageDistance,
  type SelectionImageFeatures,
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

// Same color palette, background and garment silhouette; only construction or
// stripe placement changes. These are rendered PNGs, not mocked descriptors.
const sameColorGarment = (detail: "stripes" | "neckline" | "pocket", change = 0) => {
  const silhouette = "M71 49L93 35H145L167 49L213 129L176 150L156 111L161 279H77L81 111L61 150L25 129Z";
  let details = "";
  if (detail === "stripes") for (let y = 100 + change; y < 260; y += 16)
    details += `<path d="M77 ${y}H160" stroke="#927250" stroke-width="7"/>`;
  if (detail === "pocket") details += `<rect x="${88 + change}" y="168" width="25" height="38" fill="#b8946b"/>`;
  const neckline = detail === "neckline" ? change : 0;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320">
    <rect width="240" height="320" fill="#ddd8cf"/>
    <defs><clipPath id="body"><path d="${silhouette}"/></clipPath></defs>
    <path d="${silhouette}" fill="#38281e"/>
    <path d="M93 35L119 ${84 + neckline}L145 35L133 ${119 + neckline}H106Z" fill="#a77949"/>
    <g clip-path="url(#body)">${details}</g>
    <path d="M119 84V277M88 126V251M150 126V251" stroke="#d4ba94" stroke-width="4"/>
    <circle cx="124" cy="125" r="4" fill="#e8c997"/>
    <circle cx="124" cy="153" r="4" fill="#e8c997"/>
  </svg>`);
};

// Retain the prior global-only comparison as a regression witness. All three
// hard negatives passed a 90-point threshold before local structure was added.
const globalOnlyDistance = (left: SelectionImageFeatures, right: SelectionImageFeatures) => {
  const histogram = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / 2;
  let best = 1;
  for (const a of left.variants) for (const b of right.variants) {
    const regions = a.map((region, index) => {
      const other = b[index];
      const hash = region.hash.reduce((sum, bit, at) => sum + Number(bit !== other.hash[at]), 0) / region.hash.length;
      return hash * 0.52 + histogram(region.colors, other.colors) * 0.36 + histogram(region.edges, other.edges) * 0.12;
    });
    best = Math.min(best, regions[0] * 0.3 + regions[1] * 0.4 + regions[2] * 0.3);
  }
  return best;
};

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
    expect(resizedDistance).toBeLessThan(0.1);
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
    expect(selectionImageDistance(query, flipped)).toBeLessThan(0.1);
  });

  it.each([
    ["stripes", 8], ["neckline", 35], ["pocket", 35],
  ] as const)("rejects a same-color garment with changed %s while retaining its compressed copy", async (detail, change) => {
    const [png, differentPng] = await Promise.all([
      sharp(sameColorGarment(detail)).png().toBuffer(),
      sharp(sameColorGarment(detail, change)).png().toBuffer(),
    ]);
    const jpeg = await sharp(png).resize(90, 120).jpeg({ quality: 45 }).toBuffer();
    const [query, different, compressed] = await Promise.all([
      createSelectionImageFeatures(png), createSelectionImageFeatures(differentPng), createSelectionImageFeatures(jpeg),
    ]);
    expect(globalOnlyDistance(query, different)).toBeLessThan(0.1);
    expect(selectionImageDistance(query, different)).toBeGreaterThanOrEqual(0.1);
    expect(selectionImageDistance(query, compressed)).toBeLessThan(0.1);
    expect(selectionImageDistance(query, compressed)).toBeLessThan(selectionImageDistance(query, different));
  });

  it("versions bounded local descriptors and preserves a perfect match after typed-array serialization", async () => {
    const query = await createSelectionImageFeatures(original);
    const arrays = query.variants.map(variant => variant.map(region => ({
      hash: [...region.hash], colors: [...region.colors], edges: [...region.edges],
      spatial: [...region.spatial], spatialStats: [...region.spatialStats],
    })));
    const serialized = JSON.parse(JSON.stringify(arrays)) as typeof arrays;
    const restored: SelectionImageFeatures = {
      variants: serialized.map(variant => variant.map(region => ({
        hash: Uint8Array.from(region.hash), colors: [...region.colors], edges: [...region.edges],
        spatial: Float32Array.from(region.spatial), spatialStats: Float64Array.from(region.spatialStats),
      }))),
    };
    expect(selectionImageFeatureVersion).toBe(2);
    expect(query.variants).toHaveLength(2);
    for (const variant of query.variants) {
      expect(variant).toHaveLength(3);
      for (const region of variant) {
        expect(region.spatial).toHaveLength(3072);
        expect(region.spatialStats).toHaveLength(384);
        expect([...region.spatial].every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
        expect([...region.spatialStats].every((value, index) => Number.isFinite(value) && value >= 0 && value <= (index % 2 ? 0.25 : 1))).toBe(true);
      }
    }
    expect(selectionImageDistance(query, restored)).toBe(0);
  });

  it("refuses unreadable image bytes and images above the pixel limit", async () => {
    await expect(createSelectionImageFeatures(Buffer.from("broken image"))).rejects.toThrow();
    const oversized = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "#fff" } }).png().toBuffer();
    await expect(createSelectionImageFeatures(oversized)).rejects.toThrow();
  });
});
