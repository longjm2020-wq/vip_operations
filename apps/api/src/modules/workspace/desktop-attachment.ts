import { createHash } from "node:crypto";
import { z } from "zod";
import { db, one, rows, type Tx } from "../../../../../packages/database/src/index.js";
import {
  desktopFolderAttachmentSchema, desktopFolderAttachmentsSchema, desktopFolderAttachmentRequest, desktopFolderAttachmentFollowup,
  desktopFolderAttachmentTargetPolicy, desktopFolderBatchAttachmentRequest, looksLikeDesktopFolderAttachment, looksLikeDesktopFolderBatchAttachment,
  folderBatchAttachmentGuidance, folderAttachmentGuidance, maxDesktopFolderAttachmentBytes, maxDesktopFolderAttachmentsBytes,
  maxDesktopFolderAttachments, desktopFolderSteps, type DesktopFolderCreationPlan, type DesktopFolderStep
} from "../../../../../packages/contracts/src/desktop-folder-creation.js";
import { fail, parse, type Context } from "../../core.js";
import { requireAssistant } from "./assistant-memory.js";
import { isSupportedUpload } from "./agent-files.js";

type AttachmentIntent = {
  action: "copy_folder_attachment" | "copy_folder_attachments" | "create_folders_with_attachments";
  source: "image" | "attachment";
  quantity: "single" | "multiple" | "selected";
  attachmentCount?: number;
  plan?: DesktopFolderCreationPlan;
  deviceName?: string;
  relative?: boolean;
  steps: DesktopFolderStep[];
};

export function isAttachmentManifest(action: unknown) {
  return action === "copy_folder_attachments" || action === "create_folders_with_attachments";
}

export function folderAttachmentIntent(text: string, count: number): AttachmentIntent | undefined {
  const relative = desktopFolderAttachmentFollowup(text);
  const batch = relative ? undefined : desktopFolderBatchAttachmentRequest(text);
  const single = relative || batch ? undefined : desktopFolderAttachmentRequest(text);
  const target = relative ?? batch ?? single;
  if (target) {
    const action = target.existingOnly
      ? (!relative && count === 1 ? "copy_folder_attachment" : "copy_folder_attachments")
      : "create_folders_with_attachments";
    return {
      ...target,
      quantity: batch?.quantity ?? relative?.quantity ?? "single",
      action,
      relative: !!relative,
      steps: desktopFolderSteps(action)!,
    };
  }
  if (looksLikeDesktopFolderBatchAttachment(text) || looksLikeDesktopFolderAttachment(text))
    fail("INVALID_FOLDER_ATTACHMENT", desktopFolderAttachmentTargetPolicy(text) === "unsupported"
      ? folderBatchAttachmentGuidance.targetPolicy : folderBatchAttachmentGuidance.format, 400);
}

export function validateFolderAttachmentSelection(intent: AttachmentIntent, ids: string[]) {
  if (!ids.length || ids.length > maxDesktopFolderAttachments)
    fail("FOLDER_ATTACHMENT_REQUIRED", intent.action === "copy_folder_attachment" ? folderAttachmentGuidance.attachment : folderBatchAttachmentGuidance.attachment, 400);
  if (new Set(ids.map(id => id.toLowerCase())).size !== ids.length)
    fail("FOLDER_ATTACHMENT_DUPLICATE", "同一份附件被重复选择，请核对本条消息的附件。", 400);
  if ((intent.quantity === "single" && ids.length !== 1) || (intent.attachmentCount !== undefined && intent.attachmentCount !== ids.length))
    fail("FOLDER_ATTACHMENT_REQUIRED", `指令指定 ${intent.attachmentCount ?? 1} 份文件，本条消息已选择 ${ids.length} 份，请核对后重试。`, 400);
}

export function validateFolderAttachmentFiles(intent: AttachmentIntent, files: Array<{name: string; mime: string; size: number}>) {
  if (files.some(f => f.size > maxDesktopFolderAttachmentBytes))
    fail("FILE_LIMIT", "本机附件复制支持每份最大 64 MB 的文件，请选择较小的附件。", 400);
  if (files.reduce((sum, f) => sum + f.size, 0) > maxDesktopFolderAttachmentsBytes)
    fail("FILE_LIMIT", "本次附件合计超过80MB，请分次处理", 400);
  if (intent.source === "image" && files.some(f => !["image/jpeg","image/png","image/webp"].includes(f.mime)))
    fail("FOLDER_ATTACHMENT_REQUIRED", folderBatchAttachmentGuidance.image, 400);
  const names = new Set<string>();
  for (const file of files) {
    const key = file.name.toUpperCase();
    if (names.has(key))
      fail("FOLDER_ATTACHMENT_COLLISION", `附件「${file.name}」与另一份附件在 Windows 上同名，请先区分文件名再发送。`, 400);
    names.add(key);
  }
  if (files.some(f => !desktopFolderAttachmentSchema.shape.name.safeParse(f.name).success || f.size < 1 || !isSupportedUpload(f.name, f.mime)))
    fail("FOLDER_ATTACHMENT_INVALID", "请使用有 Windows 合法文件名的非空图片、文档或视频附件。", 400);
}

export async function bindFolderAttachments(tx: Tx, c: Context, ids: string[], intent: AttachmentIntent) {
  const files = await rows(tx, `SELECT id,name,mime,size,octet_length(content) AS bytes FROM public.personal_assistant_files
    WHERE user_id=$1::bigint AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, c.actor.id, ids);
  if (files.length !== ids.length) fail("FILE_NOT_FOUND", "请选择当前账号可用的附件后再发送任务。", 404);
  validateFolderAttachmentFiles(intent, files.map(f => ({name:f.name,mime:f.mime,size:f.size})));
  if (files.some(f => f.size !== f.bytes))
    fail("FOLDER_ATTACHMENT_INVALID", "附件大小与保存的内容不符，请重新上传。", 409);
  const digests = await rows(tx, `SELECT id,encode(sha256(content),'hex') AS sha256 FROM public.personal_assistant_files
    WHERE user_id=$1::bigint AND id=ANY($2::uuid[])`, c.actor.id, ids);
  const manifest = desktopFolderAttachmentsSchema.safeParse(ids.map(id => {
    const file = files.find(f => f.id === id.toLowerCase())!;
    return {id:file.id, name:file.name, bytes:file.bytes, sha256:digests.find(d => d.id === file.id)!.sha256};
  }));
  if (!manifest.success) fail("FOLDER_ATTACHMENT_INVALID", "请使用有 Windows 合法文件名的非空附件，再发送任务。", 400);
  return manifest.data;
}

export async function downloadFolderAttachment(c: Context, deviceId: string, taskId: string, input: unknown): Promise<Buffer> {
  requireAssistant(c);
  parse(z.string().uuid(), taskId);
  const claim = parse(z.object({ authorizationId: z.string().uuid(), attemptId: z.string().uuid(), fileId: z.string().uuid().optional() }).strict(), input);
  const file = await one(db, `SELECT CASE WHEN $7::uuid IS NULL THEN t.folder_attachment ELSE (
      SELECT entry - 'id' FROM jsonb_array_elements(t.folder_attachments) entry WHERE entry->>'id'=$7::uuid::text) END AS metadata,f.name,f.content FROM assistant_desktop_tasks t
    JOIN assistant_desktop_devices d ON d.id=t.device_id AND d.user_id=t.user_id
    JOIN public.personal_assistant_files f ON f.id=coalesce($7::uuid,t.folder_attachment_id) AND f.user_id=t.user_id
    WHERE t.id=$1::uuid AND t.user_id=$2::bigint AND t.device_id=$3::uuid AND (
      (t.native_action='copy_folder_attachment' AND $7::uuid IS NULL AND d.folder_attachment)
      OR (t.native_action IN ('copy_folder_attachments','create_folders_with_attachments') AND $7::uuid IS NOT NULL
        AND d.folder_attachments AND t.folder_attachments @> jsonb_build_array(jsonb_build_object('id',$7::uuid))))
      AND t.status='RUNNING' AND t.planning_id=$4::uuid AND t.authorization_id=$5::uuid
      AND d.authorization_id=t.authorization_id AND d.platform='windows' AND d.native_actions AND d.folder_creation
      AND d.token_hash IS NOT NULL AND d.revoked_at IS NULL AND d.expires_at>now()
      AND f.size BETWEEN 1 AND $6::int AND octet_length(f.content)=f.size`,
    taskId,c.actor.id,deviceId,claim.attemptId,claim.authorizationId,maxDesktopFolderAttachmentBytes,claim.fileId ?? null);
  if (!file) fail("FOLDER_ATTACHMENT_UNAVAILABLE", "附件、原设备授权或本次执行许可已失效。", 409);
  const metadata = desktopFolderAttachmentSchema.safeParse(file.metadata);
  const content: Uint8Array = file.content;
  if (!metadata.success || metadata.data.name !== file.name || metadata.data.bytes !== content.byteLength ||
      createHash("sha256").update(content).digest("hex") !== metadata.data.sha256)
    fail("FOLDER_ATTACHMENT_CHANGED", "附件与原任务绑定的文件不一致。", 409);
  return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
}
