import { api } from "./api.js";
import { desktopClientRequest } from "./desktop-client.js";

/** One setup flow. Only the native dialog can remember authorization. */
export async function connectAndAuthorizeDesktop(ownedDeviceIds: string[]) {
  let current = await desktopClientRequest("status");
  if (current.connected && !ownedDeviceIds.includes(current.deviceId)) {
    await desktopClientRequest("show-tasks");
    throw new Error("本机连接了其他账号，请先断开本机，再连接当前账号");
  }
  if (!current.connected) {
    const { data } = await api(
      "/my-workspace/assistant/desktop/pair-code",
      "POST",
    );
    current = await desktopClientRequest("pair", data.code as string);
  }
  if (!current.connected || !current.deviceId)
    throw new Error("本机尚未连接，请重试");
  if (current.authorized === true) return current;
  // Older clients do not expose native consent through the bridge.
  if (current.authorized === undefined) {
    await desktopClientRequest("show-tasks");
    return current;
  }
  return desktopClientRequest("authorize", current.deviceId);
}

export function desktopSetupMessage(authorized?: boolean) {
  return authorized === true
    ? "已连接并记住授权，现在可以直接下达电脑操作指令"
    : authorized === false
      ? "本机已连接；尚未授权，可稍后点击「授权本机操作」"
      : "本机已连接，请在电脑任务中授权；新版桌面端支持直接确认";
}
