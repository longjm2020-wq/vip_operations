// Provider endpoints and credentials are separate from model capabilities. Only
// non-secret routing snapshots are persisted with jobs; keys stay on the server.
import {
  bailianVideoProvider,
  bailianVideoBody,
  submitBailianVideo,
  pollBailianVideo,
} from "./bailian-video.mjs";
import { createHash } from "node:crypto";
import {
  AGENTAI_ORIGIN,
  AGENTAI_VIDEOS,
  agentaiConfigured,
  prepareAgentAi,
  submitAgentAi,
  pollAgentAi,
} from "./agentai-media.mjs";
import { modelFetch, modelReceipt } from "./ai-accounting.mjs";
import { jobRequestSignal } from "./job-request.mjs";
import { videoRoleProfile } from "../shared/video-role-profile.mjs";
import { validateRoleBindingPayload } from "./video-role-binding.mjs";

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ratios = ["16:9", "9:16", "1:1", "4:3", "3:4"];
const activeVideoProtocols = new Set(["xai", "bailian", "agentai"]);

function retiredVideoRoute(route) {
  if (
    /^(?:xylp(?:-enhance)?|xhai)$/u.test(route?.id || "") ||
    /^(?:media|xhai)$/u.test(route?.protocol || "") ||
    /^(?:XYLP_|VIDEO_RELAY_API_KEY$|XHAI_API_KEY$)/u.test(route?.keyEnv || "")
  )
    return true;
  if (!route?.baseUrl) return false;
  try {
    const host = new URL(route.baseUrl).hostname.replace(/\.$/u, "");
    return (
      host === "xhai.token6688.com" ||
      /(?:^|\.)(?:lk888\.ai|xylp\.ai)$/u.test(host)
    );
  } catch {
    return false;
  }
}

function retiredVideoError() {
  return Object.assign(
    new Error(
      "原视频服务已下线，已有结果保留。请核对原任务号，并重新选择当前视频模型。",
    ),
    {
      code: "VIDEO_PROVIDER_RETIRED",
      statusCode: 409,
      terminal: true,
    },
  );
}

export function assertActiveVideoRoute(route) {
  if (retiredVideoRoute(route)) throw retiredVideoError();
  if (!activeVideoProtocols.has(route?.protocol))
    throw new Error("视频服务协议不受支持");
}

function endpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("视频服务地址必须是无凭据、无查询参数的 HTTPS URL");
  return url.href.replace(/\/+$/, "");
}

export function videoProviders(config) {
  const builtins = [
    {
      id: "xai",
      label: "xAI 官方",
      protocol: "xai",
      baseUrl: config.xaiBaseUrl || "https://api.x.ai/v1",
      keyEnv: "XAI_API_KEY",
      models: [
        {
          id: "grok",
          label: "Grok Imagine Video",
          model: config.xaiVideoModel || "grok-imagine-video-1.5",
          durations: range(1, 15),
          maxImages: 7,
          resolutions: ["720p", "480p", "1080p"],
          aspects: [...ratios, "21:9", "2:3", "3:2"],
        },
      ],
    },
  ];
  const providers = [
    ...builtins,
    bailianVideoProvider(config),
    {
      id: "agentai",
      label: "AgentAI",
      protocol: "agentai",
      baseUrl: AGENTAI_ORIGIN,
      keyEnv: "AGENTAI_API_KEY",
      models: AGENTAI_VIDEOS,
    },
  ];
  for (const item of config.videoProviders || []) {
    if (retiredVideoRoute(item)) continue;
    const at = providers.findIndex((p) => p.id === item.id);
    const provider = { ...item, models: item.models || [] };
    if (at >= 0) providers[at] = provider;
    else providers.push(provider);
  }
  for (const p of providers) {
    if (
      !/^[\w-]+$/.test(p.id) ||
      !activeVideoProtocols.has(p.protocol) ||
      retiredVideoRoute(p) ||
      !/^[A-Z][A-Z0-9_]*$/.test(p.keyEnv)
    )
      throw new Error("视频中转站配置无效");
    p.baseUrl = endpoint(p.baseUrl);
    if (
      !p.models.length ||
      new Set(p.models.map((m) => m.id)).size !== p.models.length
    )
      throw new Error("视频模型列表为空或 ID 重复");
    for (const m of p.models) {
      if (
        !m.id ||
        !m.model ||
        !m.durations?.length ||
        !m.resolutions?.length ||
        !m.aspects?.length ||
        !(m.maxImages >= 1)
      )
        throw new Error("视频模型能力配置不完整");
      if (m.inputMode && !["first-frame", "references"].includes(m.inputMode))
        throw new Error("视频模型输入模式无效");
      if (m.imagesValue && !["single", "array"].includes(m.imagesValue))
        throw new Error("视频模型图片字段类型无效");
      if (m.inputMode === "first-frame" && m.maxImages !== 1)
        throw new Error("首帧模型只接收 1 张图");
      if (m.imagesValue === "single" && m.maxImages !== 1)
        throw new Error("单图字段不能配置多张参考图");
      if (
        m.mediaReferences &&
        (p.protocol !== "bailian" || m.inputMode === "first-frame")
      )
        throw new Error("视频、音频参考仅支持已适配的多图媒体协议");
      for (const type of ["video", "audio"]) {
        const cap = m.mediaReferences?.[type];
        if (
          cap &&
          (!/^[a-z][a-z0-9_]*$/.test(cap.field || "") ||
            [
              m.imagesField,
              m.aspectField || "aspect_ratio",
              m.durationField || "duration",
              m.qualityField || "resolution",
              "prompt",
              "model",
              "__proto__",
              "constructor",
            ].includes(cap.field) ||
            !Number.isInteger(cap.maxFiles) ||
            cap.maxFiles < 1 ||
            cap.maxFiles > 10 ||
            !Array.isArray(cap.extensions) ||
            !cap.extensions.length ||
            ![
              cap.maxBytes,
              cap.minSeconds,
              cap.maxSeconds,
              cap.maxTotalSeconds,
            ].every((v) => Number.isFinite(v) && v > 0) ||
            cap.minSeconds > cap.maxSeconds ||
            !Number.isFinite(cap.priceMultiplier) ||
            cap.priceMultiplier < 0)
        )
          throw new Error("视频、音频参考能力配置无效");
      }
    }
  }
  return providers;
}

export function videoKey(config, route) {
  if (
    route.protocol === "agentai" &&
    !agentaiConfigured(config, route.model?.model)
  )
    return "";
  if (
    route.protocol === "agentai-image" &&
    !agentaiConfigured(config, route.providerModel)
  )
    return "";
  if (
    route.protocol === "bailian" &&
    route.baseUrl.includes("unconfigured.invalid")
  )
    return "";
  return route.keyEnv === "XAI_API_KEY"
    ? config.xaiApiKey
    : config.videoSecrets?.[route.keyEnv];
}

export function videoCatalog(config) {
  return videoProviders(config)
    .filter(
      (p) =>
        !config.enabledVideoProviders ||
        config.enabledVideoProviders.includes(p.id),
    )
    .map((p) => ({
      id: p.id,
      label: p.label,
      configured: p.models.some(
        (model) =>
          !model.legacy &&
          Boolean(
            videoKey(config, {
              ...p,
              model,
            }),
          ),
      ),
      models: p.models
        .filter((model) => !model.legacy)
        .map(
          ({
            id,
            model,
            label,
            group,
            channel,
            successRate,
            speedSeconds,
            priceHint,
            durations,
            durationsByResolution,
            maxImages,
            resolutions,
            aspects,
            note,
            inputMode = "references",
            minImageSide,
            mediaReferences,
          }) => ({
            id,
            label,
            group,
            channel,
            successRate,
            speedSeconds,
            priceHint,
            configured: Boolean(
              videoKey(config, {
                ...p,
                model: { model },
              }),
            ),
            durations,
            durationsByResolution,
            maxImages,
            resolutions,
            aspects,
            note,
            inputMode,
            minImageSide,
            mediaReferences,
            roleBinding: videoRoleProfile({ id, inputMode }),
          }),
        ),
    }));
}

export function selectVideoRoute(config, selection = {}) {
  if (retiredVideoRoute({ id: selection?.providerId }))
    throw retiredVideoError();
  const provider = videoProviders(config).find(
    (p) => p.id === (selection?.providerId || "xai"),
  );
  if (!provider) throw new Error("所选视频中转站不存在，请重新选择");
  const model = provider.models.find(
    (m) => m.id === (selection?.modelId || provider.models[0].id),
  );
  if (!model) throw new Error("所选视频模型不存在，请重新选择");
  const resolution = selection?.resolution || model.resolutions[0];
  if (!model.resolutions.includes(resolution))
    throw new Error("所选画质不受该模型支持");
  const selectedModel = structuredClone(model);
  selectedModel.durations =
    model.durationsByResolution?.[resolution] || model.durations;
  return {
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    keyEnv: provider.keyEnv,
    model: selectedModel,
    resolution,
  };
}

export function validateVideoInput(
  route,
  {
    prompt,
    duration,
    aspectRatio,
    referenceImages,
    referenceVideos = [],
    referenceAudios = [],
    roleBinding,
  },
) {
  assertActiveVideoRoute(route);
  const m = route.model;
  validateRoleBindingPayload(roleBinding, referenceImages);
  for (const [type, urls] of [
    ["video", referenceVideos],
    ["audio", referenceAudios],
  ]) {
    if (
      !Array.isArray(urls) ||
      (urls.length &&
        (!m.mediaReferences?.[type] ||
          route.protocol !== "bailian" ||
          urls.length > m.mediaReferences[type].maxFiles))
    )
      throw new Error(
        `当前模型不支持所选数量的${type === "video" ? "视频" : "音频"}参考，不会静默丢弃`,
      );
    for (const value of urls) {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error("生成参考素材必须使用 HTTPS 文件地址");
      }
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("生成参考素材必须使用 HTTPS 文件地址");
    }
  }
  if (m.maxPromptChars && [...(prompt || "")].length > m.maxPromptChars)
    throw new Error(
      `${m.label} 提示词超过 ${m.maxPromptChars} 字符，请缩短分镜与商品描述后重试`,
    );
  if (
    m.maxPromptBytes &&
    Buffer.byteLength(prompt || "", "utf8") > m.maxPromptBytes
  )
    throw new Error(
      `${m.label} 提示词超过 ${m.maxPromptBytes} 字节，请缩短分镜与商品描述后重试`,
    );
  if (!m.durations.includes(duration))
    throw new Error(
      `${m.label} 不支持 ${duration} 秒；支持 ${m.durations.join("、")} 秒。未提交，不会自动延长计费。`,
    );
  if (!m.aspects.includes(aspectRatio))
    throw new Error(`${m.label} 不支持 ${aspectRatio} 比例`);
  if (m.inputMode === "first-frame") {
    if (referenceImages.length !== 1)
      throw new Error(
        `${m.label} 必须且只能提交 1 张已验收首帧；不会从多张素材中自动取第一张。`,
      );
  } else if (referenceImages.length > m.maxImages || referenceImages.length < 2)
    throw new Error(
      `${m.label} 本次需要同时引用人物和商品，参考图须为 2～${m.maxImages} 张；不会静默丢弃素材。`,
    );
}

export function videoReferenceCount(
  route,
  sourceCount,
  includeKeyframe = false,
) {
  return route.model.inputMode === "first-frame"
    ? 1
    : sourceCount + Number(includeKeyframe);
}

export function videoRequestBody(route, input) {
  validateVideoInput(route, input);
  const { prompt, duration, aspectRatio, referenceImages } = input;
  const m = route.model;
  if (route.protocol === "agentai")
    return {
      model_id: m.model,
      modality: "video",
      params: {
        ...m.params,
        prompt,
        images: referenceImages,
        aspect_ratio: aspectRatio,
        duration: String(duration),
        resolution: route.resolution,
      },
    };
  if (route.protocol === "bailian") return bailianVideoBody(route, input);
  if (route.protocol === "xai")
    return {
      model: m.model,
      prompt,
      reference_images: referenceImages.map((url) => ({ url })),
      duration,
      aspect_ratio: aspectRatio,
      resolution: route.resolution,
      generate_audio: false,
    };
  throw new Error("视频服务协议不受支持");
}

export async function preflightAgentAiVideo(config, route, input) {
  assertActiveVideoRoute(route);
  if (route.protocol === "agentai") {
    const body = videoRequestBody(route, input);
    return {
      request: await prepareAgentAi(config, body),
      inputHash: createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex"),
    };
  }
  return undefined;
}

async function callXaiVideo(config, route, pathname, body) {
  const key = videoKey(config, route);
  if (!key) throw new Error(`${route.label} 尚未配置 ${route.keyEnv}`);
  const call = body
    ? (url, options) => modelFetch(config, "aigc_video", url, options)
    : fetch;
  const response = await call(`${route.baseUrl}${pathname}`, {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: jobRequestSignal(body ? 310_000 : 60_000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${route.label} HTTP ${response.status}`);
  const result = await response.json();
  return result.code !== undefined && result.data && !Array.isArray(result.data)
    ? result.data
    : result;
}

export async function submitVideo(config, route, input, preflight) {
  const body = videoRequestBody(route, input);
  if (route.protocol === "agentai") {
    const prepared = preflight?.request;
    if (
      !prepared ||
      preflight.inputHash !==
        createHash("sha256").update(JSON.stringify(body)).digest("hex")
    )
      throw Error("AgentAI 视频缺少与本次参数一致的估价，未提交");
    return submitAgentAi(config, prepared);
  }
  if (route.protocol === "bailian")
    return submitBailianVideo(config, route, input);
  const result = await callXaiVideo(config, route, "/videos/generations", body);
  const id = result.request_id;
  if (id === undefined || id === null || !String(id))
    throw new Error("供应商未返回任务编号，提交结果待核对");
  return String(id);
}

export async function pollVideo(config, route, id) {
  assertActiveVideoRoute(route);
  if (route.protocol === "agentai") {
    try {
      return await pollAgentAi(config, route.model.model, "video", id);
    } catch (error) {
      if (error.terminal) return { pending: false, state: "expired" };
      throw error;
    }
  }
  if (route.protocol === "bailian") return pollBailianVideo(config, route, id);
  const result = await callXaiVideo(
    config,
    route,
    `/videos/${encodeURIComponent(id)}`,
  );
  if (
    result.is_final === true ||
    ["done", "completed", "failed", "success"].includes(
      result.status || result.state,
    )
  )
    await modelReceipt(
      config,
      "aigc_video",
      route.baseUrl,
      route.model.model || route.model.id,
      { ...result, task_id: id },
    );
  return {
    pending: ["pending", "queued", "in_progress"].includes(result.status),
    url: result.status === "done" ? result.video?.url : undefined,
    state: result.status,
  };
}
