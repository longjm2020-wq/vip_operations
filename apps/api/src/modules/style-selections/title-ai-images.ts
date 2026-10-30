import sharp from "sharp";
import { selectionScope } from "../../../../../packages/database/src/selection-scope.js";
import { readStoredImage } from "./image-storage.js";
import { imageAccess } from "./protection.js";
import type { Context } from "../../core.js";

// Imported Jushuitan originals can exceed 2 MB. Bound the input before decoding,
// then send only the existing 1000px / 500 KB JPEG derivative to the model.
const maxImageBytes = 8 * 1024 * 1024;

export function allowedTitleImageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || url.hash || url.search) return null;
    const vip = /^[ab]\.vpimg[1-5]\.com$/u.test(url.hostname) && url.pathname.startsWith("/upload/");
    const jushuitan = (url.hostname === "images.sursung.com" && url.pathname.startsWith("/prod/item/")) ||
      (url.hostname === "images-erp.sursung.com" && url.pathname.startsWith("/prod/erp/ItemSku/"));
    if (!vip && !jushuitan) return null;
    url.protocol = "https:";
    return url.toString();
  } catch { return null; }
}
async function cappedRemoteImage(url: string) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000), headers: { Accept: "image/jpeg,image/png,image/webp" } });
  if (!response.ok || !/^image\/(?:jpeg|png|webp)(?:;|$)/iu.test(response.headers.get("content-type") || "") || Number(response.headers.get("content-length")) > maxImageBytes) {
    await response.body?.cancel(); throw Error("Unsupported remote image");
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("Empty image");
  const pieces: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.length;
      if (size > maxImageBytes) throw Error("Image too large");
      pieces.push(result.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(pieces);
}

/** The caller must pass only images already selected from its protected row projection. */
export async function readSelectionImageBytes(c: Context, url: string) {
  const scope = selectionScope.getStore() || "";
  const stored = /^\/api\/v1\/style-selections\/images\/([0-9a-f-]{36})(?:\?tableId=([1-9]\d*))?$/iu.exec(url);
  let bytes: Buffer;
  if (stored) {
    if ((stored[2] || "") !== scope || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(stored[1])) return null;
    await imageAccess(c, stored[1]);
    const image = await readStoredImage(stored[1]); bytes = Buffer.from(image.content);
  } else if (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/iu.test(url) && url.length <= 1_500_000) {
    bytes = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  } else {
    const allowed = allowedTitleImageUrl(url); if (!allowed) return null;
    bytes = await cappedRemoteImage(allowed);
  }
  if (!bytes.length || bytes.length > maxImageBytes) return null;
  return bytes;
}

export async function titleImageData(c: Context, url: string) {
  const bytes = await readSelectionImageBytes(c, url);
  if (!bytes) return null;
  const image = sharp(bytes, { limitInputPixels: 20_000_000, animated: false, failOn: "error" });
  const metadata = await image.metadata();
  if (!["jpeg", "png", "webp"].includes(metadata.format || "")) return null;
  const compressed = await image.rotate().resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }).jpeg({ quality: 75 }).toBuffer();
  if (compressed.length > 500 * 1024) return null;
  return "data:image/jpeg;base64," + compressed.toString("base64");
}
