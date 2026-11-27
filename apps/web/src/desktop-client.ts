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
      localMediaIndex?: true;
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
  return requestDesktopBridge<DesktopClientState>(
    bridge,
    {
      action,
      ...(action === "pair" ? { code: argument } : {}),
      ...(action === "authorize" ? { deviceId: argument } : {}),
      ...(browserUrl ? { url: browserUrl } : {}),
    },
    {
      timeout: openingBrowser ? 15000 : 120000,
      timeoutMessage: openingBrowser
        ? "打开本地浏览器超时，请重试"
        : "本机连接超时，请在「我的电脑」中检查状态",
      failureMessage: openingBrowser ? "本地浏览器打开失败" : "本机连接失败",
      valid: (value) =>
        typeof value?.version === "string" &&
        typeof value.connected === "boolean" &&
        typeof value.deviceId === "string" &&
        (value.authorized === undefined ||
          typeof value.authorized === "boolean") &&
        (value.engineReady === undefined ||
          typeof value.engineReady === "boolean") &&
        (value.engineError === undefined ||
          typeof value.engineError === "string") &&
        (value.stopShortcut === undefined ||
          typeof value.stopShortcut === "string") &&
        (action !== "authorize" ||
          (typeof value.authorized === "boolean" &&
            value.connected &&
            value.deviceId === argument)),
    },
    signal,
  );
}

function requestDesktopBridge<T>(
  bridge: WebViewBridge,
  request: Record<string, unknown>,
  options: {
    timeout: number;
    timeoutMessage: string;
    failureMessage: string;
    valid: (value: T) => boolean;
  },
  signal?: AbortSignal,
) {
  return new Promise<T>((resolve, reject) => {
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
              : options.failureMessage,
          ),
        );
      if (!options.valid(value.data))
        return reject(new Error("客户端返回无效，请更新客户端"));
      resolve(value.data);
    };
    const timer = setTimeout(() => {
      clean();
      reject(new Error(options.timeoutMessage));
    }, options.timeout);
    bridge.addEventListener("message", receive);
    window.addEventListener("pagehide", leave, { once: true });
    if (signal?.aborted) return cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      bridge.postMessage({
        ...request,
        channel: "xuti-desktop",
        id,
      });
    } catch {
      clean();
      reject(new Error("无法连接桌面客户端，请重新打开小序"));
    }
  });
}

export type DesktopMediaAsset = {
  id: string;
  name: string;
  relativePath: string;
  kind: "image" | "video" | "audio";
  bytes: number;
  modifiedAt: string;
};

export type DesktopMediaIndexPage = {
  indexId: string;
  folderName: string;
  total: number;
  skipped: number;
  truncated: boolean;
  items: DesktopMediaAsset[];
};

type DesktopMediaDelivery = {
  url: string;
  name: string;
  mime: string;
  bytes: number;
};

const mediaId = /^[a-f0-9]{32}$/u;
const localMediaBytes = 100 * 1024 * 1024;
const localMediaPreviewBytes = 8 * 1024 * 1024;
export const desktopMediaPageSize = 50;

export function canIndexLocalMedia() {
  return isDesktopClient() && window.xutiDesktop?.localMediaIndex === true;
}

function validMediaPage(data: DesktopMediaIndexPage) {
  return (
    !!data &&
    typeof data.indexId === "string" &&
    mediaId.test(data.indexId) &&
    typeof data.folderName === "string" &&
    Number.isSafeInteger(data.total) &&
    data.total >= 0 &&
    Number.isSafeInteger(data.skipped) &&
    data.skipped >= 0 &&
    typeof data.truncated === "boolean" &&
    Array.isArray(data.items) &&
    data.items.length <= desktopMediaPageSize &&
    data.items.every(
      (asset) =>
        asset &&
        typeof asset.id === "string" &&
        mediaId.test(asset.id) &&
        typeof asset.name === "string" &&
        typeof asset.relativePath === "string" &&
        ["image", "video", "audio"].includes(asset.kind) &&
        Number.isSafeInteger(asset.bytes) &&
        asset.bytes > 0 &&
        typeof asset.modifiedAt === "string",
    )
  );
}

function validMediaDelivery(data: DesktopMediaDelivery, cap: number) {
  return (
    !!data &&
    typeof data.url === "string" &&
    /^\/__xuti-local-media\/[a-f0-9]{32}$/u.test(data.url) &&
    typeof data.name === "string" &&
    typeof data.mime === "string" &&
    /^(?:image|audio|video)\/[a-z\d.+-]+$/iu.test(data.mime) &&
    Number.isSafeInteger(data.bytes) &&
    data.bytes > 0 &&
    data.bytes <= cap
  );
}

function requestDesktopMedia<T>(
  request: Record<string, unknown>,
  valid: (value: T) => boolean,
  signal?: AbortSignal,
) {
  const bridge = canIndexLocalMedia() ? window.chrome?.webview : undefined;
  if (!bridge)
    return Promise.reject(
      new Error("请更新小序 Windows 客户端后使用本机素材索引"),
    );
  return requestDesktopBridge<T>(
    bridge,
    request,
    {
      timeout: 120000,
      timeoutMessage: "本机素材处理超时，请缩小目录范围或重试",
      failureMessage: "本机素材处理失败",
      valid,
    },
    signal,
  );
}

export function openLocalMediaIndex(signal?: AbortSignal) {
  return requestDesktopMedia<DesktopMediaIndexPage | null>(
    { action: "media-index-open" },
    (data) => data === null || validMediaPage(data),
    signal,
  );
}

export function loadLocalMediaIndex(
  indexId: string,
  offset: number,
  search = "",
  signal?: AbortSignal,
) {
  return requestDesktopMedia<DesktopMediaIndexPage>(
    {
      action: "media-index-page",
      indexId,
      offset,
      search: search.trim().slice(0, 128),
    },
    validMediaPage,
    signal,
  );
}

async function readDesktopDelivery(
  delivery: DesktopMediaDelivery,
  signal?: AbortSignal,
) {
  // This opaque same-origin route is intercepted by the workspace WebView.
  const response = await fetch(delivery.url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (
    !response.ok ||
    response.headers.get("content-type") !== delivery.mime ||
    Number(response.headers.get("content-length")) !== delivery.bytes
  )
    throw new Error("本机素材已失效，请重新选用");
  const blob = await response.blob();
  if (blob.size !== delivery.bytes)
    throw new Error("本机素材读取不完整，请重试");
  return blob;
}

export async function previewLocalMedia(
  indexId: string,
  assetId: string,
  startSeconds = 0,
  signal?: AbortSignal,
) {
  const delivery = await requestDesktopMedia<DesktopMediaDelivery>(
    {
      action: "media-index-preview",
      indexId,
      assetId,
      startSeconds: Math.floor(startSeconds),
    },
    (data) => validMediaDelivery(data, localMediaPreviewBytes),
    signal,
  );
  const blob = await readDesktopDelivery(delivery, signal);
  return { url: URL.createObjectURL(blob), mime: delivery.mime };
}

async function selectLocalMediaFile(
  request: Record<string, unknown>,
  maxBytes: number,
  signal?: AbortSignal,
) {
  const cap = Math.min(Math.floor(maxBytes), localMediaBytes);
  if (!Number.isSafeInteger(cap) || cap <= 0)
    throw new Error("文件上传大小限制无效");
  const delivery = await requestDesktopMedia<DesktopMediaDelivery | null>(
    { ...request, maxBytes: cap },
    (data) => data === null || validMediaDelivery(data, cap),
    signal,
  );
  if (delivery === null) return null;
  return new File(
    [await readDesktopDelivery(delivery, signal)],
    delivery.name,
    { type: delivery.mime },
  );
}

export function readLocalMediaFile(
  indexId: string,
  assetId: string,
  maxBytes: number,
  signal?: AbortSignal,
) {
  return selectLocalMediaFile(
    { action: "media-index-file", indexId, assetId },
    maxBytes,
    signal,
  );
}

export function prepareLocalMediaExcerpt(
  indexId: string,
  assetId: string,
  startSeconds: number,
  maxBytes: number,
  signal?: AbortSignal,
) {
  return selectLocalMediaFile(
    {
      action: "media-index-excerpt",
      indexId,
      assetId,
      startSeconds: Math.floor(startSeconds),
    },
    maxBytes,
    signal,
  );
}
