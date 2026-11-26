import { one, type Tx } from "../../../../../packages/database/src/index.js";
import { assistantFollowupAnchor, type AssistantFollowupAnchor } from "../../../../../packages/contracts/src/assistant-execution.js";
import { desktopFolderCreationPlanSchema, desktopFolderNotesIntent } from "../../../../../packages/contracts/src/desktop-folder-creation.js";
import type { AssistantMessage } from "../../../../../packages/contracts/src/personal-assistant.js";

export type FolderSourceAnchor = AssistantFollowupAnchor & { stopped?: AssistantFollowupAnchor };

export function folderSourceAnchor(messages: AssistantMessage[], voiceSessionId?: string): FolderSourceAnchor | undefined {
  const latest = assistantFollowupAnchor(messages, voiceSessionId);
  if (latest?.kind !== "desktop" || !desktopFolderNotesIntent(messages.at(-2)!.text)) return latest;
  const before = assistantFollowupAnchor(messages.slice(0, -2), voiceSessionId);
  return before?.kind === "desktop" ? { ...before, stopped: latest } : undefined;
}

// Only the server's original completion receipt can supply paths for a relative note request.
export async function verifiedFolderSource(
  tx: Tx, userId: string, anchor: FolderSourceAnchor, deviceId?: string, requestId?: string,
) {
  if (anchor.kind !== "desktop") return;
  const source = await one(tx, `SELECT t.id,t.device_id,t.authorization_id,t.folder_creation,d.folder_notes,
      d.engine_seen_at>now()-interval '20 seconds' AND d.last_seen_at>now()-interval '20 seconds' AS online
    FROM assistant_desktop_tasks t JOIN assistant_desktop_devices d ON d.id=t.device_id AND d.user_id=t.user_id
    WHERE t.id=$1::uuid AND t.request_id=$2::uuid AND t.user_id=$3::bigint
      AND ($4::uuid IS NULL OR t.device_id=$4::uuid)
      AND t.native_action IN ('create_desktop_folders','create_folders_with_notes')
      AND t.status='DONE' AND t.step>0 AND t.last_ack IS NOT NULL
      AND t.history->-1 @> jsonb_build_object('step',t.step,'action',
        CASE WHEN t.native_action='create_folders_with_notes' THEN 'create_folders_and_notes' ELSE 'create_folders' END,'result','ok')
      AND d.platform='windows' AND d.authorization_id=t.authorization_id AND d.revoked_at IS NULL
      AND d.token_hash IS NOT NULL AND d.expires_at>now()
      AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM assistant_desktop_tasks stopped
        WHERE stopped.id=$6::uuid AND stopped.request_id=$7::uuid AND stopped.user_id=t.user_id
        AND stopped.device_id=t.device_id AND stopped.native_action IS NULL AND stopped.status='CANCELED'
        AND NOT stopped.browser_only AND stopped.created_at>=t.created_at))
      AND NOT EXISTS (SELECT 1 FROM assistant_desktop_tasks newer WHERE newer.device_id=t.device_id
        AND newer.created_at>t.created_at AND newer.request_id IS DISTINCT FROM $5::uuid
        AND newer.id IS DISTINCT FROM $6::uuid)`,
    anchor.taskId, anchor.requestId, userId, deviceId ?? null, requestId ?? null,
    anchor.stopped?.taskId ?? null, anchor.stopped?.requestId ?? null);
  if (!source) return;
  const plan = desktopFolderCreationPlanSchema.safeParse(source.folder_creation);
  if (plan.success) return { id: source.id as string, deviceId: source.device_id as string,
    authorizationId: source.authorization_id as string, plan: plan.data, capable: !!source.folder_notes, online: !!source.online };
}
