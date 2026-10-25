// The gateway's upload parameters require a public URL. Project images are
// private data URLs until the server uploads them with the operator's API key.
import { jobRequestSignal } from "./job-request.mjs";

export async function uploadXhaiImage(baseUrl, apiKey, source, additionalSignal) {
  const signal = jobRequestSignal(60_000, additionalSignal);
  signal.throwIfAborted();
  if (typeof source === "string" && source.startsWith("https://")) return source;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/]+={0,2})$/.exec(source || "");
  if (!match) throw new Error("星火 AIGC 参考图须为 HTTPS 地址或 JPG、PNG、WebP 图片数据");
  const [, mime, encoded] = match;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error("星火 AIGC 参考图须小于 25MB");
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mime }), `reference.${mime.split("/")[1] === "jpeg" ? "jpg" : mime.split("/")[1]}`);
  const response = await fetch(new URL("/v1/files", baseUrl), {
    method: "POST", redirect: "error", signal,
    headers: { Authorization: `Bearer ${apiKey}` }, body: form,
  });
  if (!response.ok) throw new Error(`星火 AIGC 参考图上传失败：HTTP ${response.status}`);
  const result = await response.json();
  if (typeof result.url !== "string" || !result.url.startsWith("https://")) throw new Error("星火 AIGC 上传未返回参考图 HTTPS 地址");
  return result.url;
}

export async function uploadXhaiImages(baseUrl, apiKey, sources) {
  const uploaded = new Map();
  const urls = [];
  const signal = jobRequestSignal(Math.max(60_000, sources.length * 60_000));
  for (const source of sources) {
    signal.throwIfAborted();
    if (!uploaded.has(source)) uploaded.set(source, await uploadXhaiImage(baseUrl, apiKey, source, signal));
    urls.push(uploaded.get(source));
  }
  return urls;
}

export async function xhaiJson(baseUrl, apiKey, pathname, body) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: body ? "POST" : "GET", redirect: "error", signal: jobRequestSignal(body ? 60_000 : 30_000),
    headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`星火 AIGC HTTP ${response.status}`);
  const result = await response.json();
  if (result.code !== undefined && result.code !== 200) throw new Error(`星火 AIGC 返回业务错误 ${result.code}`);
  return result;
}
