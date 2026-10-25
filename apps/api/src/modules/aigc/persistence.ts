import { Client } from "pg";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, stat, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { StudioPersistence } from "../../../../../packages/aigc-engine/index.mjs";

const LEASE = 91817126;
export const objectStorageReady = () =>
  Boolean(
    process.env.AWS_S3_BUCKET_NAME &&
    process.env.AWS_ENDPOINT_URL &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY,
  );
export const maxAssetBytes = () =>
  (objectStorageReady() ? 180 : 20) * 1024 * 1024;
const storageError = () =>
  Object.assign(new Error("AIGC 存储暂不可用，请稍后重试"), {
    statusCode: 503,
  });

/** One fenced engine owns a PostgreSQL session advisory lock. A deployment cannot
 * load a stale snapshot or claim another instance's provider jobs. Media bytes are
 * durable before a snapshot can reference them; the local filesystem is a cache. */
export class StudioDatabase implements StudioPersistence {
  readonly client: Client;
  private active = false;
  private s3?: S3Client;
  private known = new Set<string>();
  private hydrations = new Map<string, Promise<void>>();
  private lost?: () => void;
  constructor(connectionString = process.env.DATABASE_URL) {
    this.client = new Client({
      connectionString,
      connectionTimeoutMillis: 8000,
      keepAlive: true,
    });
    this.client.on("error", () => {
      this.active = false;
      this.lost?.();
    });
  }
  async acquire(onLost: () => void) {
    this.lost = onLost;
    await this.client.connect();
    const result = await this.client.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [LEASE],
    );
    this.active = result.rows[0].acquired;
    if (!this.active) {
      await this.client.end();
      return false;
    }
    if (objectStorageReady())
      this.s3 = new S3Client({
        endpoint: process.env.AWS_ENDPOINT_URL,
        region: process.env.AWS_DEFAULT_REGION || "auto",
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
        maxAttempts: 2,
      });
    const blobs = await this.client.query("SELECT id FROM aigc_blobs");
    this.known = new Set(blobs.rows.map((x) => x.id));
    return true;
  }
  assertActive() {
    if (!this.active) throw storageError();
  }
  async heartbeat() {
    this.assertActive();
    await this.client.query("SELECT 1");
  }
  async readState() {
    this.assertActive();
    const result = await this.client.query(
      "SELECT document FROM aigc_state WHERE id=1",
    );
    if (!result.rows[0])
      throw Object.assign(new Error("No AIGC state yet"), { code: "ENOENT" });
    return result.rows[0].document;
  }
  async writeState(data: any, assetsDir: string) {
    this.assertActive();
    const additions = Object.values<any>(data.assets || {}).filter(
      (asset) => !this.known.has(asset.id),
    );
    for (const asset of additions) {
      if (!/^[0-9a-f-]{36}\.bin$/i.test(asset.storageName))
        throw storageError();
      const source = path.join(assetsDir, asset.storageName);
      const info = await stat(source);
      if (info.size !== asset.size || info.size > maxAssetBytes())
        throw Object.assign(
          new Error(
            `当前存储支持单个文件最大 ${maxAssetBytes() / 1024 / 1024} MB`,
          ),
          { statusCode: 413 },
        );
      const key = this.s3 ? `aigc/${asset.id}/${asset.storageName}` : null;
      if (this.s3)
        await this.s3.send(
          new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME!,
            Key: key!,
            Body: createReadStream(source),
            ContentLength: info.size,
            ContentType: asset.mime,
          }),
          { abortSignal: AbortSignal.timeout(120_000) },
        );
      this.assertActive();
      await this.client.query(
        "INSERT INTO aigc_blobs(id,object_key,content,size) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
        [asset.id, key, key ? null : await readFile(source), info.size],
      );
      this.known.add(asset.id);
    }
    this.assertActive();
    await this.client.query(
      "INSERT INTO aigc_state(id,document) VALUES(1,$1::jsonb) ON CONFLICT(id) DO UPDATE SET document=EXCLUDED.document,updated_at=now()",
      [JSON.stringify(data)],
    );
  }
  async hydrate(metadata: any, filePath: string) {
    this.assertActive();
    if (
      await stat(filePath)
        .then((info) => info.size === metadata.size)
        .catch(() => false)
    )
      return;
    if (!this.hydrations.has(metadata.id))
      this.hydrations.set(
        metadata.id,
        this.download(metadata, filePath).finally(() =>
          this.hydrations.delete(metadata.id),
        ),
      );
    return this.hydrations.get(metadata.id)!;
  }
  private async download(metadata: any, filePath: string) {
    const result = await this.client.query(
      "SELECT object_key,content,size FROM aigc_blobs WHERE id=$1",
      [metadata.id],
    );
    const blob = result.rows[0];
    if (!blob) throw storageError();
    const temporary = `${filePath}.${randomUUID()}.part`;
    try {
      if (blob.object_key) {
        if (!this.s3) throw storageError();
        const result = await this.s3.send(
          new GetObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME!,
            Key: blob.object_key,
          }),
          { abortSignal: AbortSignal.timeout(120_000) },
        );
        if (!result.Body) throw storageError();
        await pipeline(
          result.Body as any,
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        );
      } else {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(temporary, blob.content, { flag: "wx", mode: 0o600 });
      }
      if ((await stat(temporary)).size !== Number(blob.size))
        throw storageError();
      await rename(temporary, filePath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async collectGarbage() {
    this.assertActive();
    // A grace period protects uploaded bytes until their state checkpoint commits.
    const result = await this.client.query(
      "SELECT b.id,b.object_key FROM aigc_blobs b WHERE b.created_at < now()-interval '24 hours' AND NOT EXISTS (SELECT 1 FROM aigc_state s WHERE s.document->'assets' ? b.id::text) LIMIT 20",
    );
    for (const item of result.rows) {
      if (item.object_key) {
        if (!this.s3) continue;
        await this.s3.send(
          new DeleteObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME!,
            Key: item.object_key,
          }),
        );
      }
      this.assertActive();
      await this.client.query("DELETE FROM aigc_blobs WHERE id=$1", [item.id]);
      this.known.delete(item.id);
    }
  }
  async close() {
    this.active = false;
    this.s3?.destroy();
    await this.client.end().catch(() => {});
  }
}
