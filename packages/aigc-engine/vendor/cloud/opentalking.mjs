// Contract: datascale-ai/opentalking @ 8c739a5a6f114daf71aeace832a668c3ad60f536.
// OpenTalking is a private inference service, never a browser-facing proxy.
export const OPENTALKING_REVISION = "8c739a5a6f114daf71aeace832a668c3ad60f536";
export const MEDIA_LIMIT = 10 * 1024 * 1024;

export function serviceUrl(value) {
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch { throw new Error("请输入有效的数字人服务地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("服务地址只需协议、主机和端口，不能包含路径、密码或查询参数");
  return url.origin;
}

export function remoteId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("数字人服务返回了无效记录编号");
  return encodeURIComponent(value);
}

export async function limitedBytes(response, maximum) {
  if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new Error("数字人服务返回的文件过大"); }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > maximum) throw new Error("数字人服务返回的数据过大");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
}

export class OpenTalkingClient {
  constructor({ baseUrl, apiKey = "", fetchImpl = fetch, timeoutMs = 30_000 }) {
    this.baseUrl = serviceUrl(baseUrl); this.apiKey = apiKey; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async request(path, { method = "GET", body, timeoutMs = this.timeoutMs, binary = false, maximum = 2 * 1024 * 1024, signal } = {}) {
    if (!this.baseUrl) throw new Error("数字人服务尚未配置");
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) throw new Error("不支持的数字人接口路径");
    const timeout = AbortSignal.timeout(timeoutMs);
    const headers = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, { method, headers, redirect: "error", signal: signal ? AbortSignal.any([timeout, signal]) : timeout, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw Object.assign(new Error("数字人服务连接中断或超时；提交结果尚未确认，请勿重复提交"), { statusCode: 502 }); }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`数字人服务请求未完成（HTTP ${response.status}）`), { statusCode: 502, upstreamStatus: response.status, rejected: [400, 401, 403, 404, 413, 415, 422].includes(response.status) });
    }
    const bytes = await limitedBytes(response, maximum);
    if (binary) return { buffer: bytes, mime: response.headers.get("content-type") || "application/octet-stream" };
    if (!bytes.length) return {};
    try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("数字人服务未返回有效数据，请先核实服务状态"); }
  }
  async catalog() {
    const [health, avatars, models] = await Promise.all([this.request("/healthz"), this.request("/avatars"), this.request("/models")]);
    if (!Array.isArray(avatars) || !Array.isArray(models.models)) throw new Error("OpenTalking 接口版本不匹配");
    return { health, avatars, models };
  }
  createAvatar({ baseId, name, model, file }) {
    const form = new FormData();
    form.set("base_avatar_id", baseId); form.set("name", name); form.set("model", model);
    form.set("person_mode", "single"); form.set("remove_background", "false");
    form.set(file.type.startsWith("image/") ? "image" : "video", file, file.name);
    return this.request("/avatars/custom", { method: "POST", body: form, timeoutMs: 120_000 });
  }
  createVideo({ avatarId, model, text, file, title, ttsProvider, ttsModel, voice }) {
    const form = new FormData();
    for (const [key, value] of Object.entries({ model, avatar_id: avatarId, title, execution_mode: "async", audio_source: file ? "upload" : "tts_text", text, tts_provider: ttsProvider, tts_model: ttsModel, voice })) if (value) form.set(key, value);
    if (file) form.set("audio_file", file, file.name);
    return this.request("/video-creation/jobs", { method: "POST", body: form, timeoutMs: 120_000 });
  }
  job(id) { return this.request(`/video-creation/jobs/${remoteId(id)}`); }
  stopJob(id) { return this.request(`/video-creation/jobs/${remoteId(id)}/stop`, { method: "POST" }); }
  video(id) { return this.request(`/exports/videos/${remoteId(id)}/download`, { binary: true, maximum: 180 * 1024 * 1024, timeoutMs: 120_000 }); }
  createSession(body) { return this.request("/sessions", { method: "POST", body, timeoutMs: 120_000 }); }
  session(id, action = "", options = {}) { return this.request(`/sessions/${remoteId(id)}${action}`, options); }
  ice() { return this.request("/sessions/webrtc/ice-config"); }
}
