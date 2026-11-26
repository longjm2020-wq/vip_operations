import { createHash } from "node:crypto";
import { z } from "zod";
import { db, one, type Tx } from "../../../../../packages/database/src/index.js";
import { desktopFolderAttachmentSchema, maxDesktopFolderAttachmentBytes } from "../../../../../packages/contracts/src/desktop-folder-creation.js";
import { fail, parse, type Context } from "../../core.js";
import { requireAssistant } from "./assistant-memory.js";
import { isSupportedUpload } from "./agent-files.js";

export async function bindFolderAttachment(tx: Tx, c: Context, fileId: string, source: "image" | "attachment") {
  // Lock the selected file until its task reference commits. The stored record supplies the name and digest.
  const file = await one(tx, `SELECT name,mime,size,octet_length(content) AS bytes,
      CASE WHEN size BETWEEN 1 AND $3::int THEN encode(sha256(content),'hex') END AS sha256
    FROM public.personal_assistant_files WHERE id=$1::uuid AND user_id=$2::bigint FOR SHARE`, fileId, c.actor.id, maxDesktopFolderAttachmentBytes);
  if (!file) fail("FILE_NOT_FOUND", "请选择当前账号可用的附件后再发送任务。", 404);
  if (file.bytes > maxDesktopFolderAttachmentBytes)
    fail("FILE_LIMIT", "本机附件复制支持最大 64 MB 的文件，请选择较小的附件。", 400);
  if (source === "image" && !["image/jpeg","image/png","image/webp"].includes(file.mime))
    fail("FOLDER_ATTACHMENT_REQUIRED", "这条指令指定了图片，请随消息附上要复制的图片。", 400);
  const metadata = desktopFolderAttachmentSchema.safeParse({ name: file.name, bytes: file.bytes, sha256: file.sha256 });
  if (!metadata.success || file.bytes !== file.size || !isSupportedUpload(file.name,file.mime))
    fail("FOLDER_ATTACHMENT_INVALID", "请使用有 Windows 合法文件名的图片、文档或视频附件，核对文件类型后重试。", 400);
  return metadata.data;
}

export async function downloadFolderAttachment(c: Context, deviceId: string, taskId: string, input: unknown): Promise<Buffer> {
  requireAssistant(c);
  parse(z.string().uuid(), taskId);
  const claim = parse(z.object({ authorizationId: z.string().uuid(), attemptId: z.string().uuid() }).strict(), input);
  const file = await one(db, `SELECT t.folder_attachment AS metadata,f.name,f.content FROM assistant_desktop_tasks t
    JOIN assistant_desktop_devices d ON d.id=t.device_id AND d.user_id=t.user_id
    JOIN public.personal_assistant_files f ON f.id=t.folder_attachment_id AND f.user_id=t.user_id
    WHERE t.id=$1::uuid AND t.user_id=$2::bigint AND t.device_id=$3::uuid AND t.native_action='copy_folder_attachment'
      AND t.status='RUNNING' AND t.planning_id=$4::uuid AND t.authorization_id=$5::uuid
      AND d.authorization_id=t.authorization_id AND d.platform='windows' AND d.native_actions AND d.folder_attachment
      AND d.token_hash IS NOT NULL AND d.revoked_at IS NULL AND d.expires_at>now()
      AND f.size BETWEEN 1 AND $6::int AND octet_length(f.content)=f.size`,
    taskId,c.actor.id,deviceId,claim.attemptId,claim.authorizationId,maxDesktopFolderAttachmentBytes);
  if (!file) fail("FOLDER_ATTACHMENT_UNAVAILABLE", "附件、原设备授权或本次执行许可已失效。", 409);
  const metadata = desktopFolderAttachmentSchema.safeParse(file.metadata);
  const content: Uint8Array = file.content;
  if (!metadata.success || metadata.data.name !== file.name || metadata.data.bytes !== content.byteLength ||
      createHash("sha256").update(content).digest("hex") !== metadata.data.sha256)
    fail("FOLDER_ATTACHMENT_CHANGED", "附件与原任务绑定的文件不一致。", 409);
  return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
}
