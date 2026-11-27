import { randomUUID } from "node:crypto";
import { fail, requireRole } from "./access.mjs";

const validModel = (value) =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value);
function baseUrl(value) {
  const url = new URL(value);
  const localTest =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (!localTest && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail("编译接口须为无凭据的 HTTPS 地址");
  return url.href.replace(/\/+$/, "");
}

export function compileProviders(config) {
  return [
    {
      id: "openrouter",
      label: "OpenRouter",
      apiKey: config.openrouterApiKey,
      model: config.openrouterModel,
      baseUrl: config.openrouterBaseUrl || "https://openrouter.ai/api/v1",
      supportsResponsePolling: false,
    },
    {
      id: "openai",
      label: "OpenAI",
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      baseUrl: "https://api.openai.com/v1",
      supportsResponsePolling: true,
    },
  ].map((provider) => ({ ...provider, baseUrl: baseUrl(provider.baseUrl) }));
}

export function selectCompiler(config, settings, snapshot) {
  const providers = compileProviders(config);
  if (snapshot?.id) {
    const provider = providers.find((item) => item.id === snapshot.id);
    if (
      !provider ||
      snapshot.keyEnv ||
      snapshot.apiFormat ||
      (snapshot.baseUrl && baseUrl(snapshot.baseUrl) !== provider.baseUrl) ||
      (typeof snapshot.supportsResponsePolling === "boolean" &&
        snapshot.supportsResponsePolling !== provider.supportsResponsePolling)
    )
      fail("原编译服务已下线或连接已变化，请核对原任务后重新拆解", 409);
    return { ...provider, model: snapshot.model || provider.model };
  }
  const selections = [
    config.managedCompiler,
    settings,
    { providerId: settings?.publicProviderId, model: settings?.publicModel },
    { providerId: config.compileProvider },
  ];
  const selection = selections.find((value) =>
    providers.some((provider) => provider.id === value?.providerId),
  );
  const provider =
    providers.find((item) => item.id === selection?.providerId) ||
    providers.find((item) => item.apiKey) ||
    providers[0];
  return { ...provider, model: selection?.model || provider.model };
}

export function publicCompiler(config, settings) {
  return selectCompiler(config, settings);
}

export function compilerForUser(config, data, _userId, snapshot) {
  return selectCompiler(config, data.compileSettings, snapshot);
}

export function compilerSnapshot(provider) {
  const { id, model, baseUrl, supportsResponsePolling } = provider;
  return { id, model, baseUrl, supportsResponsePolling };
}

export function compilerRequest(
  provider,
  { instructions, imageItems, maxOutputTokens },
) {
  const content = [{ type: "input_text", text: instructions }];
  for (const item of imageItems) {
    content.push({ type: "input_text", text: `以下是 ${item.label}。` });
    content.push({
      type: "input_image",
      image_url: item.dataUrl,
      detail: "high",
    });
  }
  return {
    pathname: "/responses",
    body: {
      model: provider.model,
      max_output_tokens: maxOutputTokens,
      input: [{ role: "user", content }],
      ...(provider.supportsResponsePolling ? { background: true } : {}),
    },
  };
}

export function assertCompilerAccess(data, userId, provider) {
  if (!["openrouter", "openai"].includes(provider?.id))
    fail("原编译服务已下线，请重新拆解", 409);
  if (
    data.platform &&
    !data.platform.users.some((item) => item.id === userId && !item.disabled)
  )
    fail("账号已停用，不能提交新请求", 403);
}

export function compilerCatalog(config, settings) {
  const selected = selectCompiler(config, settings);
  return {
    selection: { providerId: selected.id, model: selected.model },
    publicSelection: {
      providerId: selected.id,
      model: selected.model,
      label: selected.label,
      configured: Boolean(selected.apiKey),
    },
    providers: compileProviders(config).map(({ apiKey, ...provider }) => ({
      ...provider,
      configured: Boolean(apiKey),
    })),
    updatedAt: settings?.updatedAt,
  };
}

export async function saveCompilerSettings(store, config, user, input) {
  requireRole(user, ["super_admin"]);
  if (config.useModelManagement)
    fail("请在系统设置 → AI 模型管理中切换 AIGC 编译模型", 409);
  const provider = compileProviders(config).find(
    (p) => p.id === input?.providerId,
  );
  if (!provider || !validModel(input.model))
    fail("请选择编译服务并填写有效的模型 ID");
  if (!provider.apiKey) fail("该编译模型尚未配置指定渠道 API 密钥", 409);
  await store.mutate((data) => {
    if (data.platform)
      requireRole(
        data.platform.users.find((u) => u.id === user.id && !u.disabled),
        ["super_admin"],
      );
    const oldSelection = compilerForUser(config, data, user.id);
    for (const job of Object.values(data.jobs)) {
      if (
        job.type !== "compile" ||
        ["completed", "failed", "cancelled"].includes(job.status) ||
        job.payload?.compiler
      )
        continue;
      if (job.provider && !["openrouter", "openai"].includes(job.provider))
        continue;
      const original = job.provider
        ? compilerForUser(config, data, job.ownerId, { id: job.provider })
        : oldSelection;
      job.payload = { ...job.payload, compiler: compilerSnapshot(original) };
    }
    data.compileSettings = {
      providerId: provider.id,
      model: input.model,
      updatedAt: new Date().toISOString(),
    };
    data.platform?.audit.unshift({
      id: randomUUID(),
      at: data.compileSettings.updatedAt,
      actorId: user.id,
      actorName: user.username,
      action: "compile_model_update",
      target: provider.id,
      detail: input.model,
    });
  });
  return compilerCatalog(config, store.data.compileSettings);
}
