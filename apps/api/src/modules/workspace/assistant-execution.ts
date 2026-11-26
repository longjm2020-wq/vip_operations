import { folderAttachmentIntent, isAttachmentManifest } from "./desktop-attachment.js";
import {
  classifyAssistantExecution,
  type AssistantFollowupAnchor,
  classifyAssistantFollowup,
  assistantFollowupRequiresNotepad,
  canConsiderAssistantFollowup,
  isNativeDesktopAppCommand,
} from "../../../../../packages/contracts/src/assistant-execution.js";
import { db, rows } from "../../../../../packages/database/src/index.js";
import {
  desktopFolderAttachmentFollowup, desktopFolderCompoundRequest, desktopFolderCreationPlan, desktopFolderNotesIntent,
  folderAttachmentGuidance, folderBatchAttachmentGuidance, folderCompoundGuidance, folderCreationGuidance, folderNotesGuidance,
  looksLikeDesktopFolderCompound, looksLikeDesktopFolderCreation, looksLikeDesktopFolderNotes,
} from "../../../../../packages/contracts/src/desktop-folder-creation.js";
import {
  desktopFileCopyIntent,
  explicitlyRequestsBackgroundCopy, backgroundCopyScope, backgroundCopyUnavailable, requestsBackgroundDesktopExecution,
  desktopFolderCopyGuidance,
  looksLikeDesktopFolderCopy,
} from "../../../../../packages/contracts/src/desktop-file-copy.js";
import { fail, type Context } from "../../core.js";
import { canContinueBrowserGoal } from "./assistant-browser.js";
import { verifiedFolderSource, type FolderSourceAnchor } from "./folder-notes.js";

export type AutomaticAssistantExecution =
  | { kind: "site" }
  | { kind: "browser"; previousGoal?: AssistantFollowupAnchor }
  | {
      kind: "desktop";
      deviceId: string;
      localBrowser?: true;
      previousTaskId?: string;
      folderSource?: FolderSourceAnchor;
    }
  | { kind: "clarify"; message: string };

export type FollowupCandidate = {
  kind: "semantic";
  surface: "browser" | "desktop" | "localBrowser";
  target: Extract<AutomaticAssistantExecution, { kind: "browser" | "desktop" }>;
};

export const clarifyFollowup = {
  kind: "clarify" as const,
  message:
    "请告诉我要操作哪个窗口或网页，例如「在我的电脑上打开记事本」或「在独立浏览器里打开指定网址」。",
};

/** A browser reuses task IDs across goals. Bind both IDs from the adjacent stored turn. */
export async function resolveAssistantFollowup(
  c: Context,
  text: string,
  anchor: FolderSourceAnchor | undefined,
  preferredDeviceId?: string,
  explicitSurface?: "desktop" | "browser",
  requestId?: string,
): Promise<AutomaticAssistantExecution | FollowupCandidate | undefined> {
  const relative = desktopFolderAttachmentFollowup(text);
  if (relative) {
    const source = anchor && explicitSurface !== "browser" && await verifiedFolderSource(db, c.actor.id, anchor, preferredDeviceId, requestId);
    if (!source) return { kind: "clarify", message: "请先在当前对话完成并核验建目录任务，或写明桌面父文件夹名称和子文件夹名称或编号范围。" };
    if (relative.deviceName && relative.deviceName.toLowerCase() !== source.deviceName.trim().toLowerCase())
      fail("DEVICE_NAME_MISMATCH", "指令里的电脑名称和原建目录任务的设备不同。", 409);
    if (!source.online) fail("DEVICE_OFFLINE", "请在原 Windows 电脑重新连接小序桌面端再分发附件。", 409);
    if (!source.manifestFoldersCapable) fail("FOLDER_ATTACHMENT_UPDATE_REQUIRED", folderBatchAttachmentGuidance.update, 409);
    return { kind: "desktop", deviceId: source.deviceId, folderSource: anchor };
  }
  if (desktopFolderNotesIntent(text) || looksLikeDesktopFolderNotes(text)) {
    if (!desktopFolderNotesIntent(text)) return { kind: "clarify", message: folderNotesGuidance.format };
    const source = anchor && explicitSurface !== "browser" && await verifiedFolderSource(db, c.actor.id, anchor, preferredDeviceId, requestId);
    if (!source) return { kind: "clarify", message: folderNotesGuidance.source };
    if (!source.online) fail("DEVICE_OFFLINE", "请在原 Windows 电脑重新连接小序桌面端，再继续创建同名文本文件。", 409);
    if (!source.capable) fail("FOLDER_NOTES_UPDATE_REQUIRED", folderNotesGuidance.update, 409);
    return { kind: "desktop", deviceId: source.deviceId, folderSource: anchor };
  }
  const operation = classifyAssistantFollowup(text);
  if (!operation && !canConsiderAssistantFollowup(text)) return;
  if (!anchor || (explicitSurface && explicitSurface !== anchor.kind))
    return clarifyFollowup;
  let target: FollowupCandidate["target"],
    surface: FollowupCandidate["surface"];
  if (anchor.kind === "browser") {
    if (assistantFollowupRequiresNotepad(text)) return clarifyFollowup;
    if (!(await canContinueBrowserGoal(db, c.actor.id, anchor)))
      return {
        kind: "clarify",
        message:
          "请在目标网页重新下达完整指令。上次操作的网页尚未完成、已经变化或已过期。",
      };
    target = { kind: "browser", previousGoal: anchor };
    surface = "browser";
  } else {
    const [task] = await rows(
      db,
      `SELECT t.device_id,t.browser_only,t.application FROM assistant_desktop_tasks t
       JOIN assistant_desktop_devices d ON d.id=t.device_id AND d.user_id=t.user_id
       WHERE t.id=$1::uuid AND t.user_id=$2::bigint AND t.request_id=$3::uuid
         AND ($4::uuid IS NULL OR t.device_id=$4::uuid)
         AND t.status='DONE' AND t.window_id IS NOT NULL AND t.step>0
         AND t.updated_at>now()-interval '10 minutes'
         AND t.authorization_id=d.authorization_id AND d.revoked_at IS NULL AND d.token_hash IS NOT NULL
         AND d.expires_at>now() AND d.window_continuations AND d.retained_task_id=t.id
         AND d.engine_seen_at>now()-interval '20 seconds' AND d.last_seen_at>now()-interval '20 seconds'
         AND NOT EXISTS(SELECT 1 FROM assistant_desktop_tasks newer WHERE newer.device_id=t.device_id
                        AND newer.user_id=t.user_id AND newer.created_at>t.created_at)`,
      anchor.taskId,
      c.actor.id,
      anchor.requestId,
      preferredDeviceId ?? null,
    );
    if (!task)
      return {
        kind: "clarify",
        message:
          "上次操作的窗口暂时无法核验。请检查所选电脑已连接并运行新版桌面端，再明确指定要操作的窗口。",
      };
    if (
      assistantFollowupRequiresNotepad(text) &&
      (task.browser_only || task.application !== "notepad")
    )
      return clarifyFollowup;
    surface = task.browser_only ? "localBrowser" : "desktop";
    target = {
      kind: "desktop",
      deviceId: task.device_id,
      previousTaskId: anchor.taskId,
      ...(task.browser_only ? { localBrowser: true } : {}),
    };
  }
  if (!operation) return { kind: "semantic", surface, target };
  if (operation === "page" && surface === "desktop") return clarifyFollowup;
  return target;
}

export async function resolveAutomaticAssistantExecution(
  c: Context,
  instruction: string,
  preferredDeviceId?: string,
  nativeDesktopDeviceId?: string,
  options?: Parameters<typeof classifyAssistantExecution>[1],
  attachmentCount = 0,
): Promise<AutomaticAssistantExecution> {
  if (desktopFolderNotesIntent(instruction) || looksLikeDesktopFolderNotes(instruction))
    return { kind: "clarify", message: desktopFolderNotesIntent(instruction) ? folderNotesGuidance.source : folderNotesGuidance.format };
  const windowsCopy = desktopFileCopyIntent(instruction);
  const macCopy = desktopFileCopyIntent(instruction, "macos");
  const attachment = folderAttachmentIntent(instruction, attachmentCount);
  if (attachment?.relative) return {kind:"clarify",message:"请从当前对话中已核验的建目录任务继续，或写明目标子文件夹。"};
  const compound = desktopFolderCompoundRequest(instruction);
  if (!attachment && !compound && looksLikeDesktopFolderCompound(instruction))
    fail("INVALID_FOLDER_COMPOUND", folderCompoundGuidance.format, 400);
  const folderPlan = attachment?.plan ?? compound?.plan ?? desktopFolderCreationPlan(instruction);
  if (!folderPlan && looksLikeDesktopFolderCreation(instruction))
    fail("INVALID_FOLDER_CREATION", folderCreationGuidance.format, 400);
  if (!folderPlan && !windowsCopy && !macCopy && requestsBackgroundDesktopExecution(instruction))
    fail("BACKGROUND_COPY_UNAVAILABLE", backgroundCopyScope, 400);
  if (nativeDesktopDeviceId && isNativeDesktopAppCommand(instruction)) {
    const [device] =
      nativeDesktopDeviceId === preferredDeviceId
        ? await rows(
            db,
            `SELECT id,native_actions,coalesce(engine_seen_at>now()-interval '20 seconds',false) AS receiving FROM assistant_desktop_devices
          WHERE id=$1::uuid AND user_id=$2::bigint AND authorization_id IS NOT NULL
          AND token_hash IS NOT NULL AND revoked_at IS NULL AND expires_at>now()
          AND last_seen_at>now()-interval '20 seconds'`,
            nativeDesktopDeviceId,
            c.actor.id,
          )
        : [];
    if (device && device.native_actions !== null && !device.receiving)
      return {
        kind: "clarify",
        message:
          "本机已连接，但桌面端暂未接收任务。请打开「电脑任务」查看原因，恢复后再发送。",
      };
    return device
      ? { kind: "desktop", deviceId: device.id }
      : {
          kind: "clarify",
          message:
            "请在「我的电脑」核对当前设备、连接和本机跨窗口授权，再重新下达指令。",
        };
  }
  if (!folderPlan && !windowsCopy && looksLikeDesktopFolderCopy(instruction)) {
    if (
      /~\/|\/Users\/|在\s*(?:我的\s*)?Mac(?:OS)?\s*[上中里]?/iu.test(
        instruction,
      )
    )
      fail("DEVICE_PLATFORM_MISMATCH", desktopFolderCopyGuidance.platform, 400);
    fail("INVALID_COMPOUND_COPY", desktopFolderCopyGuidance.format, 400);
  }
  const target = classifyAssistantExecution(instruction, options);
  if (target.kind === "site") return { kind: "site" };
  if (target.kind === "browser") return { kind: "browser" };
  if (target.kind === "clarify")
    return {
      kind: "clarify",
      message:
        "请说明要操作哪个位置，例如「在独立浏览器里点击网页按钮」或「在我的电脑上打开 Excel」。",
    };

  const deviceName = target.deviceName;
  const filePlatform = macCopy
    ? "macos"
    : windowsCopy
      ? "windows"
      : undefined;
  if (!deviceName && !preferredDeviceId)
    return {
      kind: "clarify",
      message: attachment ? folderAttachmentGuidance.platform : folderPlan ? folderCreationGuidance.platform : filePlatform
        ? `请在右侧「我的电脑」选择执行复制的 ${filePlatform === "macos" ? "Mac" : "Windows 电脑"}，设为常用电脑后再发送。`
        : target.localBrowser
          ? "请在右侧「我的电脑」连接并选择运行小序桌面端的设备，再在右侧浏览器打开本地网页。"
          : "请在右侧「我的电脑」连接并选择常用电脑，或在指令里明确写出已连接的设备名，例如「在电脑‘办公室电脑’上打开 Excel」。",
    };

  const devices = await rows(
    db,
    `SELECT id,name,platform,native_actions,desktop_folder_copy,background_file_copy,folder_creation,folder_batch_notes,folder_attachment,folder_attachments,coalesce(engine_seen_at>now()-interval '20 seconds', false) AS receiving,
            coalesce(last_seen_at > now() - interval '20 seconds', false) AS online
       FROM assistant_desktop_devices
      WHERE user_id = $1::bigint AND token_hash IS NOT NULL
        AND revoked_at IS NULL AND expires_at > now()
        AND CASE WHEN $2::text IS NULL THEN id = $3::uuid
                 ELSE lower(btrim(name)) = lower($2::text) END
      LIMIT 2`,
    c.actor.id,
    deviceName ?? null,
    preferredDeviceId ?? null,
  );
  if (devices.length > 1)
    return {
      kind: "clarify",
      message:
        "有同名的设备。请在右侧「我的电脑」选中目标设备，再说「在我的电脑上…」。",
    };
  if (!devices[0]?.online)
    return {
      kind: "clarify",
      message: devices[0]
        ? `电脑「${devices[0].name}」已离线。请在这台电脑打开桌面端，或在右侧「我的电脑」选择目标设备。`
        : "指定的电脑暂未连接或已离线。请在右侧「我的电脑」恢复连接后再试。",
    };
  if (windowsCopy?.destinationKind && devices[0].platform !== "windows")
    fail("DEVICE_PLATFORM_MISMATCH", desktopFolderCopyGuidance.platform, 400);
  if (folderPlan && devices[0].platform !== "windows")
    fail("DEVICE_PLATFORM_MISMATCH", attachment ? folderAttachmentGuidance.platform : folderCreationGuidance.platform, 400);
  if (isAttachmentManifest(attachment?.action) && !devices[0].folder_attachments)
    fail("FOLDER_ATTACHMENT_UPDATE_REQUIRED", folderBatchAttachmentGuidance.update, 409);
  if (attachment && !devices[0].folder_attachment)
    fail("FOLDER_ATTACHMENT_UPDATE_REQUIRED", folderAttachmentGuidance.update, 409);
  if (compound && !devices[0].folder_batch_notes)
    fail("FOLDER_COMPOUND_UPDATE_REQUIRED", folderCompoundGuidance.update, 409);
  if (folderPlan && !devices[0].folder_creation)
    fail("FOLDER_CREATION_UPDATE_REQUIRED", folderCreationGuidance.update, 409);
  if (filePlatform && explicitlyRequestsBackgroundCopy(instruction) && (devices[0].platform !== "windows" || !devices[0].background_file_copy))
    fail("BACKGROUND_COPY_UNAVAILABLE", backgroundCopyUnavailable, 409);
  if (filePlatform && devices[0].platform !== filePlatform)
    return {
      kind: "clarify",
      message: `这些路径属于 ${filePlatform === "macos" ? "Mac" : "Windows"}。请在「我的电脑」选择对应设备后再发送。`,
    };
  if (windowsCopy?.destinationKind && !devices[0].desktop_folder_copy)
    fail("DESKTOP_FOLDER_COPY_UPDATE", desktopFolderCopyGuidance.update, 409);
  if (devices[0].native_actions !== null && !devices[0].receiving)
    return {
      kind: "clarify",
      message: `电脑「${devices[0].name}」已连接，但桌面端暂未接收任务。请在该电脑打开「电脑任务」查看原因，恢复后再发送。`,
    };
  return {
    kind: "desktop",
    deviceId: devices[0].id,
    ...(target.localBrowser ? { localBrowser: true } : {}),
  };
}
