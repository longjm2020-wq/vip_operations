import { captureVipPage } from "./competitor-capture.js";
import {
  localCollectorUrl,
  localCollectorVersion,
} from "./competitor-local.js";

declare const chrome: any;

// These three entry points are serialized into separate MV3 isolated scripts.
// They never receive session cookies, app tokens or arbitrary script commands.
function extensionBridge(origin: string) {
  if (window.top !== window || location.origin !== origin) return;
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (
      event.source !== window ||
      event.origin !== origin ||
      (location.pathname !== "/analytics/competitors" &&
        m?.cmd !== "RELEASE") ||
      m?.channel !== "XUTI_LOCAL_REQUEST" ||
      m?.v !== 1 ||
      typeof m.id !== "string" ||
      !/^[\da-f-]{36}$/i.test(m.id) ||
      !["PING", "NAVIGATE", "READ", "FOCUS", "RELEASE"].includes(m.cmd)
    )
      return;
    chrome.runtime.sendMessage(
      { v: 1, cmd: m.cmd, runId: m.runId, url: m.url },
      (reply: unknown) => {
        const error = chrome.runtime.lastError;
        window.postMessage(
          {
            channel: "XUTI_LOCAL_RESPONSE",
            v: 1,
            id: m.id,
            reply: error
              ? { ok: false, error: "采集助手已断开，请刷新经营系统页面" }
              : reply,
          },
          origin,
        );
      },
    );
  });
}

function extensionBackground(
  origin: string,
  version: string,
  allowedUrl: typeof localCollectorUrl,
) {
  let pending = Promise.resolve();
  const key = "collector";
  async function execute(m: any, sender: any) {
    const owner = sender.tab?.id;
    let senderUrl: URL;
    try {
      senderUrl = new URL(sender.url);
    } catch {
      throw Error("来源无效");
    }
    if (
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      !Number.isInteger(owner) ||
      senderUrl.origin !== origin ||
      (senderUrl.pathname !== "/analytics/competitors" &&
        m?.cmd !== "RELEASE") ||
      m?.v !== 1
    )
      throw Error("来源无效");
    if (m.cmd === "PING") return { version };
    if (typeof m.runId !== "string" || !/^[\da-f-]{36}$/i.test(m.runId))
      throw Error("任务无效");
    let s = (await chrome.storage.session.get(key))[key];
    if (s && s.owner !== owner) {
      try {
        await chrome.tabs.get(s.owner);
      } catch {
        s = null;
      }
      if (s) throw Error("另一个经营系统标签页正在采集，请先在该页面停止任务");
    }
    if (m.cmd === "RELEASE") {
      if (s && s.runId === m.runId) await chrome.storage.session.remove(key);
      return {};
    }
    if (s && s.runId !== m.runId)
      throw Error("旧任务尚未停止，请刷新页面后重新连接");
    if (m.cmd === "NAVIGATE") {
      const url = allowedUrl(m.url);
      if (!url) throw Error("只支持指定品牌销量第一页和唯品会商品详情页");
      if (s && Date.now() - s.navigatedAt < 1800)
        throw Error("页面切换过快，请稍后继续");
      let tab;
      if (s) {
        try {
          tab = await chrome.tabs.get(s.tabId);
        } catch {
          /* User closed our dedicated tab. */
        }
      }
      if (tab) tab = await chrome.tabs.update(tab.id, { url });
      else tab = await chrome.tabs.create({ url, active: false });
      s = {
        owner,
        runId: m.runId,
        tabId: tab.id,
        url,
        navigatedAt: Date.now(),
      };
      await chrome.storage.session.set({ [key]: s });
      return {};
    }
    if (!s || s.runId !== m.runId)
      throw Error("本机任务已断开，请重新开始更新");
    if (m.cmd === "FOCUS") {
      const tab = await chrome.tabs.update(s.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return {};
    }
    if (m.cmd !== "READ") throw Error("操作不支持");
    const tab = await chrome.tabs.get(s.tabId);
    // Only host names are examined; no authentication URL or account data leaves the extension.
    if (tab.url?.startsWith("https://passport.vip.com/"))
      return {
        status: "LOGIN",
        note: "请在唯品会页面扫码登录，完成后返回这里继续",
      };
    if (tab.status !== "complete" || tab.pendingUrl) return { status: "WAIT" };
    try {
      return await chrome.tabs.sendMessage(s.tabId, {
        cmd: "READ_PRODUCT",
        expectedUrl: s.url,
      });
    } catch {
      return { status: "WAIT", note: "商品页面尚未就绪，请检查采集标签页" };
    }
  }
  chrome.runtime.onMessage.addListener(
    (m: any, sender: any, reply: (data: unknown) => void) => {
      const operation = pending.then(() => execute(m, sender));
      pending = operation.then(
        () => undefined,
        () => undefined,
      );
      operation.then(
        (data) => reply({ ok: true, data }),
        (error) =>
          reply({
            ok: false,
            error: error instanceof Error ? error.message : "本机采集失败",
          }),
      );
      return true;
    },
  );
  chrome.tabs.onRemoved.addListener((id: number) => {
    void chrome.storage.session.get(key).then((state: any) => {
      if (state[key]?.owner === id) return chrome.storage.session.remove(key);
    });
  });
  // A full reload cancels the page's runner; don't strand its session lock.
  chrome.tabs.onUpdated.addListener((id: number, change: any) => {
    if (change.status === "loading")
      void chrome.storage.session.get(key).then((state: any) => {
        if (state[key]?.owner === id) return chrome.storage.session.remove(key);
      });
  });
}

function extensionVip(
  collect: typeof captureVipPage,
  allowedUrl: typeof localCollectorUrl,
) {
  chrome.runtime.onMessage.addListener(
    (m: any, sender: any, reply: (data: unknown) => void) => {
      if (
        sender.id !== chrome.runtime.id ||
        sender.tab ||
        m?.cmd !== "READ_PRODUCT"
      )
        return;
      const text = document.body?.innerText || "";
      const visible = (el: Element) =>
        !!(el as HTMLElement).offsetWidth && !!(el as HTMLElement).offsetHeight;
      if (
        location.hostname === "passport.vip.com" ||
        /^(扫码登录|账户登录)$/m.test(text)
      ) {
        reply({ status: "LOGIN", note: "请在唯品会页面完成登录后继续" });
        return;
      }
      if (
        /验证|captcha/i.test(location.pathname) ||
        /请输入图中的.*字符|请完成.*验证|拖动.*滑块/.test(text) ||
        Array.from(
          document.querySelectorAll('input[placeholder*="验证码"]'),
        ).some(visible)
      ) {
        reply({
          status: "VERIFY",
          note: "唯品会要求验证，请亲自在采集标签页处理后继续",
        });
        return;
      }
      if (allowedUrl(location.href) !== m.expectedUrl) {
        reply({
          status: "ERROR",
          note: "页面跳转到其他商品或品牌，已停止读取",
        });
        return;
      }
      try {
        const data = collect({
          href: location.href,
          observedAt: new Date().toISOString(),
        });
        // Normal scrolling loads the next visible cards. No private APIs or hidden state.
        if (data.kind === "LIST" && data.products.length < 50)
          window.scrollBy({ top: 700, behavior: "instant" });
        reply({ status: "READY", data });
      } catch (error) {
        reply({
          status: "WAIT",
          note: error instanceof Error ? error.message : "商品数据尚未加载",
        });
      }
    },
  );
}

export function localExtensionFiles(appOrigin: string) {
  const u = new URL(appOrigin);
  if (
    u.origin !== appOrigin ||
    u.username ||
    u.password ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname))
    )
  )
    throw Error("Invalid application origin");
  const appPattern = `${u.protocol}//${u.hostname}/*`;
  // Match patterns cannot restrict ports. Both the bridge and worker enforce the exact origin.
  const vipPatterns = [
    "https://category.vip.com/*",
    "https://detail.vip.com/*",
    "https://passport.vip.com/*",
  ];
  const wrap = (code: string) => `(()=>{const __name=(fn)=>fn;${code}})();`;
  return {
    "manifest.json": JSON.stringify(
      {
        manifest_version: 3,
        name: "衣序 · 唯品会本机采集助手",
        version: localCollectorVersion,
        description:
          "在本机正常浏览唯品会公开商品，将榜单与规格参数返回指定衣序经营系统。",
        permissions: ["storage"],
        host_permissions: [appPattern, ...vipPatterns],
        background: { service_worker: "background.js" },
        content_scripts: [
          {
            matches: [appPattern],
            js: ["bridge.js"],
            run_at: "document_start",
            all_frames: false,
          },
          {
            matches: vipPatterns,
            js: ["vip.js"],
            run_at: "document_idle",
            all_frames: false,
          },
        ],
      },
      null,
      2,
    ),
    "bridge.js": wrap(
      `(${extensionBridge.toString()})(${JSON.stringify(appOrigin)});`,
    ),
    "background.js": wrap(
      `(${extensionBackground.toString()})(${JSON.stringify(appOrigin)},${JSON.stringify(localCollectorVersion)},${localCollectorUrl.toString()});`,
    ),
    "vip.js": wrap(
      `(${extensionVip.toString()})(${captureVipPage.toString()},${localCollectorUrl.toString()});`,
    ),
  };
}
