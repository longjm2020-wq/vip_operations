import { classifyAssistantExecution } from "../../../../../packages/contracts/src/assistant-execution.js";
import { db, rows } from "../../../../../packages/database/src/index.js";
import type { Context } from "../../core.js";

export type AutomaticAssistantExecution =
  | { kind: "site" }
  | { kind: "browser" }
  | { kind: "desktop"; deviceId: string; localBrowser?: true }
  | { kind: "clarify"; message: string };

export async function resolveAutomaticAssistantExecution(
  c: Context,
  instruction: string,
  preferredDeviceId?: string,
): Promise<AutomaticAssistantExecution> {
  const target = classifyAssistantExecution(instruction);
  if (target.kind === "site") return { kind: "site" };
  if (target.kind === "browser") return { kind: "browser" };
  if (target.kind === "clarify")
    return {
      kind: "clarify",
      message:
        "请说明要操作哪个位置，例如「在独立浏览器里点击网页按钮」或「在我的电脑上打开 Excel」。",
    };

  const deviceName = target.deviceName;
  if (!deviceName && !preferredDeviceId)
    return {
      kind: "clarify",
      message: target.localBrowser
        ? "请在右侧「我的电脑」连接并选择运行小序桌面端的设备，再在右侧浏览器打开本地网页。"
        : "请在右侧「我的电脑」连接并选择常用电脑，或在指令里明确写出已连接的设备名，例如「在电脑‘办公室电脑’上打开 Excel」。",
    };

  const devices = await rows(
    db,
    `SELECT id, coalesce(last_seen_at > now() - interval '20 seconds', false) AS online
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
      message:
        "指定的电脑暂未连接或已离线。请在右侧「我的电脑」恢复连接后再试。",
    };
  return {
    kind: "desktop",
    deviceId: devices[0].id,
    ...(target.localBrowser ? { localBrowser: true } : {}),
  };
}
