import { randomUUID } from "node:crypto";
import { fail, requireRole } from "./access.mjs";
import { videoProviders } from "./video-providers.mjs";

const validModel = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value);
export const XHAI_COMPILE_MODELS = [
  { id: "gt-6-astra", label: "GT-6 Astra" },
  { id: "gt-5.6-sol", label: "GT-5.6 Sol" },
  { id: "gt-5.6-terra", label: "GT-5.6 Terra" },
];
export const XYLP_CHAT_MODELS = [
  { id: "tt-6-astra", label: "TT-6 阿斯特拉", keyEnv: "XYLP_CHAT_ASTRA_KEY", channel: "ZG-Codex-Gpt-1", successRate: 94.4, speedSeconds: 31.1, priceHint: "输入 5.8788 / 输出 29.394 算力每百万 token（≤27.2 万上下文）", guide: "复杂拆解、长分镜与细节校验；按实际输入/输出 token 计费。" },
  { id: "tt-6-sol", label: "TT-6 太阳能", keyEnv: "XYLP_CHAT_SOL6_KEY", channel: "ZG-Codex-Gpt-2 / DE-defaults（备用）", successRate: 100, speedSeconds: 32, priceHint: "低价线输入 1.8754 / 输出 9.3769 算力每百万 token（≤27.2 万上下文）；备用线输入 19.7644 / 输出 98.8218", guide: "日常脚本编译与快速迭代，优先低价线；低价线当前临时拥挤时可切备用线。" },
  { id: "tt-5.6-sol", label: "TT-5.6 太阳能", keyEnv: "XYLP_CHAT_SOL56_KEY", channel: "TM-CodeX team/plus号池", successRate: 98.5, speedSeconds: 30.3, priceHint: "输入 2.484 / 输出 14.49 算力每百万 token", guide: "常规分镜和批量文案；优先控制费用。" },
];
function baseUrl(value) {
  const url = new URL(value);
  const localTest = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!localTest && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) fail("编译接口须为无凭据的 HTTPS 地址");
  return url.href.replace(/\/+$/, "");
}
export function compileProviders(config) {
  const relay = videoProviders(config).find(p => p.id === "xylp" && p.protocol === "media");
  const relayBase = config.compileRelayBaseUrl || (relay?.baseUrl || "https://api.lk888.ai").replace(/\/v1$/, "") + "/v1";
  const keyEnv = config.compileRelayKeyEnv || relay?.keyEnv || "VIDEO_RELAY_API_KEY";
  if (!/^[A-Z][A-Z0-9_]*$/.test(keyEnv)) fail("编译服务密钥环境变量名无效");
  return [
    { id: "openrouter", label: "OpenRouter", apiKey: config.openrouterApiKey, model: config.openrouterModel, baseUrl: config.openrouterBaseUrl || "https://openrouter.ai/api/v1", supportsResponsePolling: false },
    { id: "openai", label: "OpenAI", apiKey: config.openaiApiKey, model: config.openaiModel, baseUrl: "https://api.openai.com/v1", supportsResponsePolling: true },
    { id: "xylp", label: "玄宇令牌聊天 / 编译", apiKey: config.videoSecrets?.XYLP_CHAT_ASTRA_KEY, model: config.compileRelayModel || "tt-6-astra", models: XYLP_CHAT_MODELS.map(model => ({ ...model, configured: Boolean(config.videoSecrets?.[model.keyEnv]) })), baseUrl: relayBase, keyEnv, supportsResponsePolling: false },
    { id: "xhai", label: "星火 AIGC", apiKey: config.videoSecrets?.XHAI_API_KEY, model: XHAI_COMPILE_MODELS[0].id, models: XHAI_COMPILE_MODELS, baseUrl: `${(config.xhaiBaseUrl || "https://xhai.token6688.com").replace(/\/v1\/?$/, "").replace(/\/+$/, "")}/v1`, keyEnv: "XHAI_API_KEY", apiFormat: "chat", supportsResponsePolling: false },
  ].map(p => ({ ...p, baseUrl: baseUrl(p.baseUrl) }));
}

export function selectCompiler(config, settings, snapshot) {
  const providers = compileProviders(config);
  const selectedId = snapshot?.id || settings?.providerId || config.compileProvider;
  const provider = providers.find(p => p.id === selectedId) || providers.find(p => p.apiKey) || providers[0];
  if (snapshot?.id && snapshot.id !== provider.id) fail("原编译服务已不可用，请检查配置");
  const chosenModel = snapshot?.model || (!snapshot && settings?.providerId === provider.id ? settings.model : undefined) || provider.model;
  const result = { ...provider, model: chosenModel };
  if (provider.id === "xylp" && !snapshot?.keyEnv) {
    result.keyEnv = provider.models.find(model => model.id === chosenModel)?.keyEnv || provider.keyEnv;
    result.apiKey = config.videoSecrets?.[result.keyEnv];
  }
  if (snapshot?.baseUrl) result.baseUrl = baseUrl(snapshot.baseUrl);
  if (snapshot?.keyEnv) result.apiKey = config.videoSecrets?.[snapshot.keyEnv];
  if (snapshot?.supportsResponsePolling !== undefined) result.supportsResponsePolling = snapshot.supportsResponsePolling;
  if (snapshot?.apiFormat) result.apiFormat = snapshot.apiFormat;
  return result;
}
export function publicCompiler(config, settings) {
  const providers = compileProviders(config).filter(provider => provider.id !== "xhai");
  const requestedId = settings?.providerId === "xhai"
    ? settings.publicProviderId
    : settings?.providerId || (config.compileProvider !== "xhai" ? config.compileProvider : undefined);
  const provider = providers.find(item => item.id === requestedId) || providers.find(item => item.apiKey) || providers[0];
  const requestedModel = settings?.providerId === "xhai" ? settings.publicModel : settings?.model;
  const model = provider.id === requestedId && requestedModel ? requestedModel : provider.model;
  if (provider.id !== "xylp") return { ...provider, model };
  const keyEnv = provider.models.find(item => item.id === model)?.keyEnv || provider.keyEnv;
  return { ...provider, model, keyEnv, apiKey: config.videoSecrets?.[keyEnv] };
}
export function compilerForUser(config, data, userId, snapshot) {
  if (snapshot?.id) return selectCompiler(config, data.compileSettings, snapshot);
  const role = data.platform?.users.find(user => user.id === userId && !user.disabled)?.role;
  return role === "super_admin" || !data.platform
    ? selectCompiler(config, data.compileSettings)
    : publicCompiler(config, data.compileSettings);
}
export function compilerSnapshot(provider) {
  const { id, model, baseUrl, supportsResponsePolling, keyEnv, apiFormat } = provider;
  return { id, model, baseUrl, supportsResponsePolling, ...(keyEnv ? { keyEnv } : {}), ...(apiFormat ? { apiFormat } : {}) };
}
export function compilerRequest(provider, { instructions, imageItems, maxOutputTokens }) {
  if (provider.apiFormat === "chat") {
    const content = [{ type: "text", text: instructions }];
    for (const item of imageItems) {
      content.push({ type: "text", text: `以下是 ${item.label}。` });
      content.push({ type: "image_url", image_url: { url: item.dataUrl, detail: "high" } });
    }
    return { pathname: "/chat/completions", body: { model: provider.model, messages: [{ role: "user", content }], max_tokens: maxOutputTokens, stream: false } };
  }
  const content = [{ type: "input_text", text: instructions }];
  for (const item of imageItems) {
    content.push({ type: "input_text", text: `以下是 ${item.label}。` });
    content.push({ type: "input_image", image_url: item.dataUrl, detail: "high" });
  }
  return { pathname: "/responses", body: { model: provider.model, max_output_tokens: maxOutputTokens, input: [{ role: "user", content }], ...(provider.supportsResponsePolling ? { background: true } : {}) } };
}
export function assertCompilerAccess(data, userId, provider) {
  if (provider?.id !== "xhai" || !data.platform) return;
  const user = data.platform.users.find(item => item.id === userId && !item.disabled);
  if (user?.role !== "super_admin") fail("星火 AIGC 编译模型仅限超级管理员使用", 403);
}
export function compilerCatalog(config, settings) {
  const selected = selectCompiler(config, settings);
  const publicSelection = publicCompiler(config, settings);
  return {
    selection: { providerId: selected.id, model: selected.model },
    publicSelection: { providerId: publicSelection.id, model: publicSelection.model, label: publicSelection.label, configured: Boolean(publicSelection.apiKey) },
    providers: compileProviders(config).map(({ apiKey, ...provider }) => ({ ...provider, models: provider.models?.map(({ keyEnv, ...model }) => model), configured: provider.id === "xylp" ? provider.models.some(model => model.configured) : Boolean(apiKey) })),
    updatedAt: settings?.updatedAt,
    relayNote: "线路按所用 API 密钥的策略调度；共享视频密钥时沿用原策略。更换编译专用密钥可配置 COMPILE_RELAY_KEY_ENV，接口地址可用 COMPILE_RELAY_BASE_URL。",
    pricing: { checkedAt: "2026-09-27", unit: "供应商算力 / 百万 token", models: XYLP_CHAT_MODELS.map(({ id, channel, priceHint, successRate, speedSeconds }) => ({ id, channel, priceHint, successRate, speedSeconds })) },
  };
}
export async function saveCompilerSettings(store, config, user, input) {
  requireRole(user, ["super_admin"]);
  const provider = compileProviders(config).find(p => p.id === input?.providerId);
  if (!provider || !validModel(input.model)) fail("请选择编译服务并填写有效的模型 ID");
  if (!(provider.id === "xylp" ? config.videoSecrets?.[provider.models.find(model => model.id === input.model)?.keyEnv] : provider.apiKey)) fail("该编译模型尚未配置指定渠道 API 密钥", 409);
  if (provider.models && !provider.models.some(model => model.id === input.model)) fail("请选择已接入的编译模型");
  await store.mutate(data => {
    if (data.platform) requireRole(data.platform.users.find(u => u.id === user.id && !u.disabled), ["super_admin"]);
    // Freeze pre-existing queued jobs before applying a new global selection.
    for (const job of Object.values(data.jobs)) {
      if (job.type === "compile" && !["completed", "failed", "cancelled"].includes(job.status) && !job.payload?.compiler) {
        const original = compilerForUser(config, data, job.ownerId, job.provider ? { id: job.provider } : undefined);
        job.payload = { ...job.payload, compiler: compilerSnapshot(original) };
      }
    }
    const previousPublic = publicCompiler(config, data.compileSettings);
    const publicSelection = provider.id === "xhai" ? previousPublic : { ...provider, model: input.model };
    data.compileSettings = { providerId: provider.id, model: input.model, publicProviderId: publicSelection.id, publicModel: publicSelection.model, updatedAt: new Date().toISOString() };
    data.platform?.audit.unshift({ id: randomUUID(), at: data.compileSettings.updatedAt, actorId: user.id, actorName: user.username, action: "compile_model_update", target: provider.id, detail: input.model });
  });
  return compilerCatalog(config, store.data.compileSettings);
}
