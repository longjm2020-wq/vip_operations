import {
  assistantFollowupAnchor,
  assistantFollowupMaxAgeMs,
  assistantFollowupRequiresNotepad,
  canConsiderAssistantFollowup,
  classifyAssistantExecution,
  classifyAssistantFollowup,
  isNativeDesktopAppCommand,
  shouldSearchAssistantPublicWeb,
} from "../../../packages/contracts/src/assistant-execution";
import { looksLikeDesktopFolderAttachment, looksLikeDesktopFolderBatchAttachment } from "../../../packages/contracts/src/desktop-folder-creation";
import type { AssistantMessage } from "../../../packages/contracts/src/personal-assistant";
import type { BrowserState } from "../../../packages/contracts/src/assistant-browser";
import type { DesktopState } from "../../../packages/contracts/src/assistant-desktop";
import { parseAssistantWebsiteRequest } from "../../../packages/contracts/src/assistant-web-command";
import { parseVoiceCommand } from "../../../packages/contracts/src/assistant-voice-commands";

export type DraftTarget =
  | { mode: "chat" | "cloud" }
  | { mode: "desktop"; deviceId?: string }
  | { mode: "local"; deviceId: string };

type DraftRoute = (
  ReturnType<typeof classifyAssistantExecution> | { kind: "pending" }
) & { label: string };

/** Preview the current draft. The server independently checks the receipt and target at dispatch. */
export function workbenchDraftTarget(
  text: string,
  options: {
    target?: DraftTarget;
    messages: AssistantMessage[];
    desktop?: DesktopState;
    browser?: BrowserState;
    deviceId?: string;
    native: boolean;
    attachments: boolean;
  },
): DraftRoute {
  const { target, desktop, browser, deviceId, attachments } = options;
  const deviceName = (id?: string) =>
    desktop?.devices.find((device) => device.id === id)?.name;
  const computer = (name?: string) =>
    name ? `操作我的电脑 · ${name}` : "操作我的电脑";
  if (target?.mode === "desktop")
    return {
      kind: "desktop",
      label: computer(deviceName(target.deviceId) || "请选择设备"),
    } as const;
  if (target?.mode === "local")
    return { kind: "desktop", label: "操作网页 · 本地" } as const;
  if (target?.mode === "cloud")
    return { kind: "browser", label: "操作网页 · 云端" } as const;
  const search = !attachments && shouldSearchAssistantPublicWeb(text);
  const chat = {
    kind: "site",
    label: search ? "普通对话 · 联网搜索" : "普通对话",
  } as const;
  if (target?.mode === "chat" || search) return chat;
  if (attachments && !looksLikeDesktopFolderAttachment(text) && !looksLikeDesktopFolderBatchAttachment(text)) return chat;
  if (!text.trim()) return { kind: "site", label: "自动识别" } as const;
  const route = classifyAssistantExecution(text);
  if (route.kind === "desktop")
    return {
      ...route,
      label: route.localBrowser
        ? "操作网页 · 本地"
        : computer(route.deviceName || deviceName(deviceId)),
    };
  if (route.kind === "browser") return { ...route, label: "操作网页 · 云端" };
  if (options.native && isNativeDesktopAppCommand(text))
    return { kind: "desktop", label: computer(deviceName(deviceId)) } as const;
  const clarify = { kind: "clarify", label: "待确认操作位置" } as const;
  if (route.kind === "clarify") return clarify;
  const followup = classifyAssistantFollowup(text);
  if (followup) {
    const anchor = assistantFollowupAnchor(options.messages);
    const needsNotepad = assistantFollowupRequiresNotepad(text);
    const recent = (updatedAt: string) =>
      Date.now() - Date.parse(updatedAt) <= assistantFollowupMaxAgeMs;
    if (anchor?.kind === "desktop") {
      const task = desktop?.tasks.find((entry) => entry.id === anchor.taskId);
      const device = desktop?.devices.find(
        (entry) => entry.id === task?.deviceId,
      );
      if (
        task?.canContinueTyping &&
        task.window &&
        recent(task.updatedAt) &&
        device?.online &&
        (!deviceId || task.deviceId === deviceId)
      ) {
        if (
          needsNotepad &&
          (task.localBrowser || !task.nativeAction?.endsWith("_notepad"))
        )
          return clarify;
        if (task.localBrowser)
          return { kind: "desktop", label: "操作网页 · 本地" } as const;
        if (followup === "type")
          return {
            kind: "desktop",
            label: computer(`${task.window} · ${device.name}`),
          };
      }
    }
    if (anchor?.kind === "browser" && !needsNotepad) {
      const task = browser?.tasks.find((entry) => entry.id === anchor.taskId);
      if (
        task?.mode === "BROWSE" &&
        task.status === "PAUSED" &&
        task.automationStatus === "DONE" &&
        task.navigationState === "READY" &&
        recent(task.updatedAt)
      )
        return { kind: "browser", label: "操作网页 · 云端" } as const;
    }
    return clarify;
  }
  if (parseAssistantWebsiteRequest(text))
    return { kind: "site", label: "打开网页" } as const;
  if (parseVoiceCommand(text))
    return { kind: "site", label: "站内操作" } as const;
  if (
    assistantFollowupAnchor(options.messages) &&
    canConsiderAssistantFollowup(text)
  )
    return { kind: "pending", label: "自动识别" };
  return chat;
}
