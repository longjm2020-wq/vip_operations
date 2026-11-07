type ClientState = {
  version: string;
  connected: boolean;
  deviceId: string;
  authorized?: boolean;
};
type WebViewBridge = {
  postMessage: (message: unknown) => void;
  addEventListener: (
    event: "message",
    handler: (event: MessageEvent) => void,
  ) => void;
  removeEventListener: (
    event: "message",
    handler: (event: MessageEvent) => void,
  ) => void;
};
declare global {
  interface Window {
    xutiDesktop?: Readonly<{ version: string }>;
    chrome?: { webview?: WebViewBridge };
  }
}

export function isDesktopClient() {
  return (
    typeof window !== "undefined" &&
    !!window.xutiDesktop?.version &&
    !!window.chrome?.webview
  );
}

/** Opens native controls/consent. It cannot grant permission or execute input itself. */
export function desktopClientRequest(
  action: "status" | "pair" | "authorize" | "show-tasks",
  argument?: string,
) {
  const bridge =
    typeof window !== "undefined" ? window.chrome?.webview : undefined;
  if (!isDesktopClient() || !bridge)
    return Promise.reject(new Error("请在小序桌面端中使用此功能"));
  if (action === "pair" && !/^[a-f0-9]{32}$/.test(argument || ""))
    return Promise.reject(new Error("配对码无效，请重新连接"));
  if (
    action === "authorize" &&
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(argument || "")
  )
    return Promise.reject(new Error("设备无效，请重新连接"));
  return new Promise<ClientState>((resolve, reject) => {
    const id = crypto.randomUUID();
    const clean = () => {
      clearTimeout(timer);
      bridge.removeEventListener("message", receive);
      window.removeEventListener("pagehide", leave);
    };
    const leave = () => {
      clean();
      reject(new Error("页面已切换，请重新连接"));
    };
    const receive = (event: MessageEvent) => {
      const value = event.data;
      if (!value || value.channel !== "xuti-desktop" || value.id !== id) return;
      clean();
      if (!value.ok)
        return reject(
          new Error(
            typeof value.error === "string" ? value.error : "本机连接失败",
          ),
        );
      if (
        typeof value.data?.version !== "string" ||
        typeof value.data?.connected !== "boolean" ||
        typeof value.data?.deviceId !== "string" ||
        (value.data.authorized !== undefined &&
          typeof value.data.authorized !== "boolean") ||
        (action === "authorize" &&
          (typeof value.data.authorized !== "boolean" ||
            !value.data.connected ||
            value.data.deviceId !== argument))
      )
        return reject(new Error("客户端返回无效，请更新客户端"));
      resolve(value.data);
    };
    const timer = setTimeout(() => {
      clean();
      reject(new Error("本机连接超时，请在顶部电脑任务中检查状态"));
    }, 120000);
    bridge.addEventListener("message", receive);
    window.addEventListener("pagehide", leave, { once: true });
    try {
      bridge.postMessage({
        channel: "xuti-desktop",
        id,
        action,
        ...(action === "pair" ? { code: argument } : {}),
        ...(action === "authorize" ? { deviceId: argument } : {}),
      });
    } catch {
      clean();
      reject(new Error("无法连接桌面客户端，请重新打开小序"));
    }
  });
}
