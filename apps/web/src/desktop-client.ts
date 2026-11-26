import { assistantWebsiteUrl } from "../../../packages/contracts/src/assistant-web-command.js";

export type DesktopClientState = {
  version: string;
  connected: boolean;
  deviceId: string;
  authorized?: boolean;
  engineReady?: boolean;
  engineError?: string;
  stopShortcut?: string;
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
    xutiDesktop?: Readonly<{
      version: string;
      localBrowser?: true;
      nativeUpdates?: true;
      director?: true;
    }>;
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

export function canOpenLocalBrowser() {
  return isDesktopClient() && window.xutiDesktop?.localBrowser === true;
}

export function openLocalBrowser(url?: string) {
  return desktopClientRequest("open-local-browser", url);
}

/** Opens native controls/consent. It cannot grant permission or execute input itself. */
export function desktopClientRequest(
  action: "status" | "pair" | "authorize" | "show-tasks" | "open-local-browser",
  argument?: string,
  signal?: AbortSignal,
) {
  const bridge =
    typeof window !== "undefined" ? window.chrome?.webview : undefined;
  if (!isDesktopClient() || !bridge)
    return Promise.reject(new Error("请在小序桌面端中使用此功能"));
  const openingBrowser = action === "open-local-browser";
  const browserAddress = openingBrowser ? argument?.trim() : undefined;
  const browserUrl = browserAddress
    ? assistantWebsiteUrl(browserAddress)
    : undefined;
  if (openingBrowser && !canOpenLocalBrowser())
    return Promise.reject(new Error("请更新小序桌面端后打开本地浏览器"));
  if (browserAddress && !browserUrl)
    return Promise.reject(new Error("请输入不含账号和密码的 HTTPS 网址"));
  if (action === "pair" && !/^[a-f0-9]{32}$/.test(argument || ""))
    return Promise.reject(new Error("配对码无效，请重新连接"));
  if (
    action === "authorize" &&
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(argument || "")
  )
    return Promise.reject(new Error("设备无效，请重新连接"));
  return new Promise<DesktopClientState>((resolve, reject) => {
    const id = crypto.randomUUID();
    const clean = () => {
      clearTimeout(timer);
      bridge.removeEventListener("message", receive);
      window.removeEventListener("pagehide", leave);
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      clean();
      reject(signal?.reason);
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
            typeof value.error === "string"
              ? value.error
              : openingBrowser
                ? "本地浏览器打开失败"
                : "本机连接失败",
          ),
        );
      if (
        typeof value.data?.version !== "string" ||
        typeof value.data?.connected !== "boolean" ||
        typeof value.data?.deviceId !== "string" ||
        (value.data.authorized !== undefined &&
          typeof value.data.authorized !== "boolean") ||
        (value.data.engineReady !== undefined &&
          typeof value.data.engineReady !== "boolean") ||
        (value.data.engineError !== undefined &&
          typeof value.data.engineError !== "string") ||
        (value.data.stopShortcut !== undefined &&
          typeof value.data.stopShortcut !== "string") ||
        (action === "authorize" &&
          (typeof value.data.authorized !== "boolean" ||
            !value.data.connected ||
            value.data.deviceId !== argument))
      )
        return reject(new Error("客户端返回无效，请更新客户端"));
      resolve(value.data);
    };
    const timer = setTimeout(
      () => {
        clean();
        reject(
          new Error(
            openingBrowser
              ? "打开本地浏览器超时，请重试"
              : "本机连接超时，请在「我的电脑」中检查状态",
          ),
        );
      },
      openingBrowser ? 15000 : 120000,
    );
    bridge.addEventListener("message", receive);
    window.addEventListener("pagehide", leave, { once: true });
    if (signal?.aborted) return cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      bridge.postMessage({
        channel: "xuti-desktop",
        id,
        action,
        ...(action === "pair" ? { code: argument } : {}),
        ...(action === "authorize" ? { deviceId: argument } : {}),
        ...(browserUrl ? { url: browserUrl } : {}),
      });
    } catch {
      clean();
      reject(new Error("无法连接桌面客户端，请重新打开小序"));
    }
  });
}
