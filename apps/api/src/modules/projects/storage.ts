import { createHash } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ProjectAttachment } from "../../../../../packages/contracts/src/project-attachments.js";
import { fail } from "../../core.js";

export function storageEnabled() {
  return Boolean(process.env.AWS_S3_BUCKET_NAME);
}
function config() {
  const {
    AWS_ENDPOINT_URL: endpoint,
    AWS_S3_BUCKET_NAME: bucket,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
  } = process.env;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    fail("STORAGE_UNAVAILABLE", "文件存储尚未配置完整，请联系管理员", 503);
  return {
    bucket: bucket!,
    client: new S3Client({
      endpoint,
      region: process.env.AWS_DEFAULT_REGION || "auto",
      forcePathStyle: true,
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      },
      maxAttempts: 2,
    }),
  };
}
export function assertReferences(
  files: ProjectAttachment[],
  previous: ProjectAttachment[],
) {
  for (const f of files.filter((f) => f.storageKey)) {
    const old = previous.find((p) => p.id === f.id);
    if (
      !old ||
      old.storageKey !== f.storageKey ||
      old.name !== f.name ||
      old.size !== f.size ||
      old.type !== f.type
    )
      fail("FORBIDDEN", "附件不属于当前项目或已被修改，请刷新后重试", 403);
  }
}
export async function storeFiles(
  files: ProjectAttachment[],
  actor: string,
): Promise<ProjectAttachment[]> {
  if (!storageEnabled()) return files.map(({ url: _url, ...f }) => f);
  const { bucket, client } = config();
  try {
    const result: ProjectAttachment[] = [];
    for (const { url: _url, ...file } of files) {
      if (file.storageKey) {
        result.push(file);
        continue;
      }
      const bytes = Buffer.from(file.data.split(",")[1], "base64");
      const storageKey = `projects/${actor}/${file.id}-${createHash("sha256").update(bytes).digest("hex")}`;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storageKey,
          Body: bytes,
          ContentType: file.type,
        }),
        { abortSignal: AbortSignal.timeout(120000) },
      );
      result.push({ ...file, data: "", storageKey });
    }
    return result;
  } catch {
    fail("STORAGE_UNAVAILABLE", "附件上传失败，项目未保存，请重试", 503);
  } finally {
    client.destroy();
  }
}
export async function fileUrl(file: ProjectAttachment, preview: boolean) {
  const { bucket, client } = config();
  try {
    return await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: file.storageKey!,
        ResponseContentType:
          preview && file.type.startsWith("image/")
            ? file.type
            : "application/octet-stream",
        ResponseContentDisposition: `${preview && file.type.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      }),
      { expiresIn: 60 },
    );
  } finally {
    client.destroy();
  }
}

// Same-origin reading for local OCR; callers must authorize the file first.
export async function imageBytes(file: ProjectAttachment) {
  if (!file.type.startsWith("image/") || file.size > 1024 * 1024)
    fail("VALIDATION", "仅支持读取1 MB以内的证件图片", 400);
  const { bucket, client } = config();
  try {
    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: file.storageKey! }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    if (!result.Body) fail("NOT_FOUND", "图片内容不存在", 404);
    return Buffer.from(await result.Body!.transformToByteArray());
  } finally {
    client.destroy();
  }
}
