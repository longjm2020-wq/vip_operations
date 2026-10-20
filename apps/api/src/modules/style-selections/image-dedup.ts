import { createHash } from "node:crypto";
import { rows, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { uniqueSelectionImages, type SelectionImageIdentity } from "../../../../../packages/contracts/src/selection-image-dedup.js";

const storedId = (url: string) => /^\/api\/v1\/style-selections\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?tableId=[1-9]\d*)?$/i.exec(url)?.[1].toLowerCase();
const inlineBytes = (url: string) => /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url)?.[1];
const fields = ["images", "labelImages"] as const;

/** Read immutable checksums only. External URLs are kept whole (including
 * signed queries), and are never fetched or compared through visual similarity. */
export async function selectionImageDeduplicator(tx: Tx, images: readonly SelectionImageIdentity[]) {
  const ids = [...new Set(images.map(image => storedId(image.url)).filter((id): id is string => !!id))];
  const hashes = new Map<string, string>();
  // A single stored image cannot duplicate another stored image in this set;
  // still resolve it when inline bytes could be an older copy of that image.
  if (ids.length > 1 || ids.length && images.some(image => !!inlineBytes(image.url))) {
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const files = await rows(tx, `SELECT id::text,coalesce(nullif(sha256,''),encode(sha256(content),'hex')) AS sha256
        FROM public.style_selection_images WHERE id=ANY($1::uuid[])`, ids.slice(offset, offset + 1000));
      for (const file of files) if (/^[a-f0-9]{64}$/i.test(file.sha256 || "")) hashes.set(String(file.id).toLowerCase(), file.sha256.toLowerCase());
    }
  }
  const inlineHashes = new Map<string, string>();
  return <T extends SelectionImageIdentity>(values: readonly T[]): T[] => uniqueSelectionImages(values, image => {
    const id = storedId(image.url), encoded = inlineBytes(image.url);
    let hash = id ? hashes.get(id) : undefined;
    if (encoded) {
      hash = inlineHashes.get(image.url);
      if (!hash) { hash = createHash("sha256").update(Buffer.from(encoded, "base64")).digest("hex"); inlineHashes.set(image.url, hash); }
    }
    return hash ? `sha256:${hash}` : id ? `stored:${id}` : image.url;
  });
}

/** Normalize only supplied image fields, never rewrite historical storage on a
 * read or while saving an unrelated cell. Always call after authorization. */
export async function deduplicateSelectionImageFields(tx: Tx, records: Row[]): Promise<Row[]> {
  const imageSets = records.flatMap(record => fields.flatMap(key => Array.isArray(record[key]) ? [record[key] as SelectionImageIdentity[]] : []));
  if (!imageSets.some(images => images.length > 1)) return records;
  const deduplicate = await selectionImageDeduplicator(tx, imageSets.filter(images => images.length > 1).flat());
  return records.map(record => ({ ...record, ...Object.fromEntries(fields.filter(key => Array.isArray(record[key])).map(key => [key, deduplicate(record[key])])) }));
}
