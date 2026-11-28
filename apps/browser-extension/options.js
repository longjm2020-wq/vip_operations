const input = document.getElementById("origin");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");

chrome.storage.sync.get({ xutiOrigin: "https://vip-web-production.up.railway.app" }, (items) => {
  input.value = items.xutiOrigin || "";
});

saveBtn.addEventListener("click", () => {
  const raw = (input.value || "").trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("invalid protocol");
    }
    chrome.storage.sync.set({ xutiOrigin: parsed.origin }, () => {
      statusEl.style.color = "#52c41a";
      statusEl.textContent = `已保存：${parsed.origin}`;
    });
  } catch {
    statusEl.style.color = "#ff4d4f";
    statusEl.textContent = "请输入有效的 http:// 或 https:// 站点地址";
  }
});
