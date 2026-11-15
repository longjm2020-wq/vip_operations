import { api } from "./api.js";
import { desktopClientRequest } from "./desktop-client.js";
import type { DesktopState } from "../../../packages/contracts/src/assistant-desktop.js";

/** One setup flow. Only the native dialog can remember authorization. */
export async function connectAndAuthorizeDesktop(
  ownedDeviceIds: string[],
  isCurrent: () => boolean = () => true,
) {
  const checkCurrent = () => {
    if (!isCurrent()) throw new Error("连接流程已结束，请重新操作本机");
  };
  checkCurrent();
  let current = await desktopClientRequest("status");
  checkCurrent();
  if (current.connected && !ownedDeviceIds.includes(current.deviceId)) {
    // The panel's device list may predate a connection or still be loading.
    const latest = (await api("/my-workspace/assistant/desktop"))
      .data as DesktopState;
    checkCurrent();
    if (!latest.devices.some((device) => device.id === current.deviceId))
      throw new Error(
        "本机连接不属于当前登录账号，请在「电脑任务」断开后重新连接",
      );
  }
  if (!current.connected) {
    const { data } = await api(
      "/my-workspace/assistant/desktop/pair-code",
      "POST",
    );
    checkCurrent();
    current = await desktopClientRequest("pair", data.code as string);
    checkCurrent();
  }
  if (!current.connected || !current.deviceId)
    throw new Error("本机尚未连接，请重试");
  if (current.authorized === true) return current;
  // Older clients do not expose native consent through the bridge.
  if (current.authorized === undefined) {
    await desktopClientRequest("show-tasks");
    checkCurrent();
    return current;
  }
  const authorized = await desktopClientRequest("authorize", current.deviceId);
  checkCurrent();
  return authorized;
}

export function desktopSetupMessage(authorized?: boolean) {
  return authorized === true
    ? "已连接并记住授权，现在可以直接下达电脑操作指令"
    : authorized === false
      ? "已取消授权，点击「操作本机」可以重新开始"
      : "本机已连接，请在电脑任务中授权；新版桌面端支持直接确认";
}
