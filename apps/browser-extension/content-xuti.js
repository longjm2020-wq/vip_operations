/**
 * XUTI 页面安全桥接脚本：
 * 仅在匹配用户配置的 XUTI 站点且带有 ?extImport=1 参数时运行，
 * 将插件缓存的抖音/小红书爆款作品通过 window.postMessage 递交给已登录的 XUTI 工作台。
 */

(async function bridgeXutiImport() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("extImport") !== "1") return;

  const { xutiOrigin } = await chrome.storage.sync.get({
    xutiOrigin: "http://localhost:5173",
  });
  let configuredOrigin = "";
  try {
    configuredOrigin = new URL(String(xutiOrigin || "")).origin;
  } catch {
    return;
  }
  if (window.location.origin !== configuredOrigin) return;

  const { pendingImport } = await chrome.storage.local.get("pendingImport");
  if (!pendingImport || !pendingImport.sourceUrl) return;
  // 忽略超过 10 分钟的过期缓存
  if (Date.now() - Number(pendingImport.capturedAt || 0) > 10 * 60 * 1000) {
    await chrome.storage.local.remove("pendingImport");
    return;
  }

  let dispatched = false;
  const dispatch = async () => {
    if (dispatched) return;
    dispatched = true;
    window.postMessage(
      { type: "XUTI_EXT_IMPORT_WORKFLOW", payload: pendingImport },
      window.location.origin,
    );
    await chrome.storage.local.remove("pendingImport");
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === "XUTI_EXT_READY") {
      void dispatch();
    }
  });

  // 兜底：若页面在脚本加载前已就绪，延迟 800ms 派发一次
  setTimeout(() => {
    void dispatch();
  }, 800);
})();
