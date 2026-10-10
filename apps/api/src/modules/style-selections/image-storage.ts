import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { db, one, rows, type Row, type Tx } from "../../../../../packages/database/src/index.js";
import { fail } from "../../core.js";

export const imageStorageEnabled = () => Boolean(process.env.AWS_S3_BUCKET_NAME);
let client: S3Client | undefined;
function storage() {
  const { AWS_ENDPOINT_URL: endpoint, AWS_S3_BUCKET_NAME: bucket, AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) fail("STORAGE_UNAVAILABLE", "图片存储未配置完整", 503);
  client ??= new S3Client({ endpoint, region: process.env.AWS_DEFAULT_REGION || "auto", forcePathStyle: true, credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! }, maxAttempts: 2 });
  return { client, bucket: bucket! };
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function put(key: string, type: string, bytes: Buffer) {
  const { client, bucket } = storage();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: type }), { abortSignal: AbortSignal.timeout(8000) });
}
async function get(key: string) {
  const { client, bucket } = storage();
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(8000) });
  if (!result.Body) throw Error("Empty image object");
  return Buffer.from(await result.Body.transformToByteArray());
}

// Only immutable image bytes are cached. Controllers authorize every request first.
const cache = new Map<string, { bytes: Buffer; expires: number }>();
const pending = new Map<string, Promise<Buffer>>();
let cacheBytes = 0;
function remember(key: string, bytes: Buffer) {
  const old = cache.get(key);
  if (old) cacheBytes -= old.bytes.length;
  cache.delete(key);
  cache.set(key, { bytes, expires: Date.now() + 60000 }); cacheBytes += bytes.length;
  while (cacheBytes > 16 * 1024 * 1024) {
    const first = cache.keys().next().value!;
    cacheBytes -= cache.get(first)!.bytes.length; cache.delete(first);
  }
}
async function cached(key: string, hash: string, size: number) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.bytes;
  if (!pending.has(key)) pending.set(key, get(key).then(bytes => {
    if (bytes.length !== size || digest(bytes) !== hash) throw Error("Image checksum mismatch");
    remember(key, bytes); return bytes;
  }).finally(() => pending.delete(key)));
  return pending.get(key)!;
}

export async function insertImage(tx: Tx, id: string, type: string, bytes: Buffer, actor: string) {
  const hash = digest(bytes);
  const key = imageStorageEnabled() ? `selection-images/${id}/${hash}` : null;
  if (key) {
    try { await put(key, type, bytes); }
    catch { fail("STORAGE_UNAVAILABLE", "图片上传失败，请重试", 503); }
  }
  await rows(tx, `INSERT INTO style_selection_images(id,content_type,content,created_by,storage_key,byte_size,sha256)
    VALUES($1::uuid,$2,$3,$4::bigint,$5,$6::int,$7)`, id, type, key ? null : bytes, actor, key, bytes.length, hash);
}

// Internal callers may reuse metadata read from this table in the same request.
// The metadata's identifier must match; normal controller calls still read it here.
export async function readStoredImage(id: string, metadataOnly = false, metadata?: Row) {
  const file = metadata?.id === id ? metadata : await one(db, "SELECT content_type,storage_key,byte_size,sha256 FROM style_selection_images WHERE id=$1::uuid", id);
  if (!file) fail("NOT_FOUND", "图片不存在", 404);
  if (metadataOnly) return file!;
  if (file!.storage_key) {
    try { return { ...file!, content: await cached(file!.storage_key, file!.sha256, file!.byte_size) }; }
    catch {
      // Historical copies remain available until a separate, verified cleanup.
      const backup = await one(db, "SELECT content FROM style_selection_images WHERE id=$1::uuid", id);
      if (backup?.content) return { ...file!, content: backup.content };
      fail("STORAGE_UNAVAILABLE", "图片暂时无法读取，请重试", 503);
    }
  }
  const original = await one(db, "SELECT content FROM style_selection_images WHERE id=$1::uuid", id);
  return { ...file!, content: original!.content };
}

export async function migrateImageBatch(limit = 5) {
  if (!imageStorageEnabled()) return { migrated: 0, remaining: 0, skipped: true };
  const files = await rows(db, "SELECT id,content_type,content FROM style_selection_images WHERE storage_key IS NULL ORDER BY created_at,id LIMIT $1::int", limit);
  let migrated = 0;
  for (const file of files) {
    const bytes = Buffer.from(file.content), hash = digest(bytes), key = `selection-images/${file.id}/${hash}`;
    await put(key, file.content_type, bytes);
    const verified = await get(key);
    if (verified.length !== bytes.length || digest(verified) !== hash) throw Error("Image migration verification failed");
    await rows(db, "UPDATE style_selection_images SET storage_key=$2,sha256=$3,byte_size=$4::int,storage_verified_at=now() WHERE id=$1::uuid AND storage_key IS NULL", file.id, key, hash, bytes.length);
    migrated++;
  }
  const count = await one(db, "SELECT count(*)::int AS n FROM style_selection_images WHERE storage_key IS NULL");
  return { migrated, remaining: count!.n, skipped: false };
}

export function startImageMigration() {
  if (!imageStorageEnabled() || process.env.SELECTION_IMAGE_MIGRATION === "off") return;
  const run = async () => {
    let delay = 1000;
    try {
      const result = await migrateImageBatch();
      console.log(JSON.stringify({ event: "selection-image-migration", ...result }));
      if (!result.remaining) return;
    } catch { delay = 60000; console.warn("Selection image migration paused; original images remain available. Retrying in 60 seconds."); }
    setTimeout(() => void run(), delay).unref();
  };
  setTimeout(() => void run(), 10000).unref();
}
