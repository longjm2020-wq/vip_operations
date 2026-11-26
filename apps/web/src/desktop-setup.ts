import { api } from "./api.js";
import {
  desktopClientRequest,
  isDesktopClient,
  type DesktopClientState,
} from "./desktop-client.js";
import type {
  DesktopDevice,
  DesktopState,
} from "../../../packages/contracts/src/assistant-desktop.js";

export function desktopReceiverProblem(
  device: DesktopDevice,
  client?: DesktopClientState,
) {
  const local =
    client?.connected && client.deviceId === device.id ? client : undefined;
  if (local?.engineReady === false && local.engineError)
    return local.engineError;
  if (!device.online) return "所选电脑离线，请打开该电脑的小序桌面端。";
  if (local?.engineReady === false || device.engineReady === false)
    return "桌面端尚未接收任务。请在这台电脑打开「电脑任务」查看原因。";
  return "";
}

/** Recheck the device already chosen by the user in both the shell and the account. */
export async function readNativeWorkbenchDevice(preferredId?: string) {
  if (!preferredId || !isDesktopClient()) return undefined;
  try {
    const signal = AbortSignal.timeout(5000);
    const [native, { data }] = await Promise.all([
      desktopClientRequest("status", undefined, signal),
      api("/my-workspace/assistant/desktop", "GET", undefined, undefined, {
        signal,
        cache: "no-store",
      }),
    ]);
    if (
      !native.connected ||
      native.authorized !== true ||
      native.deviceId !== preferredId
    )
      return undefined;
    const device = (data as DesktopState).devices.find(
      (entry) => entry.id === preferredId,
    );
    return device &&
      !desktopReceiverProblem(device, native) &&
      device.crossWindowAuthorized === true
      ? preferredId
      : undefined;
  } catch {
    return undefined;
  }
}

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
      ? "已取消授权，可点击「使用我的电脑」重新授权"
      : "本机已连接，请在电脑任务中授权；新版桌面端支持直接确认";
}
