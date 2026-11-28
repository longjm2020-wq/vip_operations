/**
 * XUTI 浏览器插件后台服务（Manifest V3）
 * 负责在抖音、小红书页面注册右键菜单，捕获作品元数据与兜底视频直链，
 * 并通过复用浏览器已登录态打开 XUTI 服装口播工作台完成安全导入。
 */

const MENU_ASSISTED = "xuti-deconstruct-assisted";
const MENU_AUTO = "xuti-deconstruct-auto";

const SUPPORTED_PATTERNS = [
  "https://*.douyin.com/*",
  "https://*.iesdouyin.com/*",
  "https://*.xiaohongshu.com/*",
  "https://*.rednote.com/*",
  "https://*.xhslink.com/*",
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ASSISTED,
      title: "一键拆解复刻到 XUTI（人工介入修改）",
      contexts: ["page", "video", "link", "image"],
      documentUrlPatterns: SUPPORTED_PATTERNS,
    });
    chrome.contextMenus.create({
      id: MENU_AUTO,
      title: "一键拆解复刻到 XUTI（全自动模式）",
      contexts: ["page", "video", "link", "image"],
      documentUrlPatterns: SUPPORTED_PATTERNS,
    });
  });
});

/**
 * 注入到抖音/小红书当前标签页执行的纯函数，提取页面作品信息与已加载视频流直链（作为服务端反爬兜底）。
 */
function captureSocialPagePayload() {
  const url = window.location.href;
  const host = window.location.hostname.toLowerCase();
  const sourcePlatform = /douyin\.com|iesdouyin\.com/.test(host)
    ? "douyin"
    : /xiaohongshu\.com|rednote\.com|xhslink\.com/.test(host)
      ? "xhs"
      : "url";

  const meta = (selector) =>
    document.querySelector(selector)?.getAttribute("content")?.trim() || "";

  const title =
    meta('meta[property="og:title"]') ||
    document.querySelector("h1")?.textContent?.trim() ||
    document.title.replace(/\s*[-_|].*$/, "").trim();

  const description =
    meta('meta[name="description"]') ||
    meta('meta[property="og:description"]') ||
    "";

  const coverUrl =
    meta('meta[property="og:image"]') ||
    document.querySelector("video")?.getAttribute("poster") ||
    "";

  const author =
    document.querySelector('[data-e2e="video-author-name"]')?.textContent?.trim() ||
    document.querySelector(".author-wrapper .username")?.textContent?.trim() ||
    "";

  // 提取当前页面可见 <video> 元素的公开直链（排除 blob: 协议）
  let fallbackVideoUrl = "";
  const videos = Array.from(document.querySelectorAll("video"));
  for (const v of videos) {
    const src =
      v.currentSrc ||
      v.getAttribute("src") ||
      v.querySelector("source")?.getAttribute("src") ||
      "";
    if (/^https?:\/\//i.test(src)) {
      fallbackVideoUrl = src;
      break;
    }
  }

  return {
    sourcePlatform,
    sourceUrl: url,
    title: title.slice(0, 180),
    author: author.slice(0, 80),
    coverUrl: /^https?:\/\//i.test(coverUrl) ? coverUrl : "",
    fallbackVideoUrl,
    description: description.slice(0, 1500),
  };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (
    (info.menuItemId !== MENU_ASSISTED && info.menuItemId !== MENU_AUTO) ||
    !tab?.id
  ) {
    return;
  }

  const stored = await chrome.storage.sync.get({
    xutiOrigin: "https://vip-web-production.up.railway.app",
  });
  const xutiOrigin = String(stored.xutiOrigin || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(xutiOrigin)) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  let payload = {
    sourcePlatform: "url",
    sourceUrl: info.linkUrl || info.pageUrl || tab.url || "",
    title: tab.title || "",
    author: "",
    coverUrl: "",
    fallbackVideoUrl: "",
    description: "",
  };

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureSocialPagePayload,
    });
    if (results?.[0]?.result?.sourceUrl) {
      payload = { ...payload, ...results[0].result };
    }
  } catch {
    // 若页面脚本注入受限，保留右键上下文获取的链接继续导入
  }

  const runMode = info.menuItemId === MENU_AUTO ? "auto" : "assisted";
  await chrome.storage.local.set({
    pendingImport: {
      ...payload,
      runMode,
      capturedAt: Date.now(),
    },
  });

  const targetUrl = `${xutiOrigin}/aigc?view=talk-video&mode=workflow&extImport=1`;
  await chrome.tabs.create({ url: targetUrl });
});
