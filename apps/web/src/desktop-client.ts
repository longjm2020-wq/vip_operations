type ClientState = { version: string; connected: boolean; deviceId: string };
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

/** This bridge only connects this device and displays native controls. It cannot execute input. */
export function desktopClientRequest(
  action: "status" | "pair" | "show-tasks",
  code?: string,
) {
  const bridge =
    typeof window !== "undefined" ? window.chrome?.webview : undefined;
  if (!isDesktopClient() || !bridge)
    return Promise.reject(new Error("请在小序桌面端中使用此功能"));
  if (action === "pair" && !/^[a-f0-9]{32}$/.test(code || ""))
    return Promise.reject(new Error("配对码无效，请重新连接"));
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
        typeof value.data?.deviceId !== "string"
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
        ...(action === "pair" ? { code } : {}),
      });
    } catch {
      clean();
      reject(new Error("无法连接桌面客户端，请重新打开小序"));
    }
  });
}
