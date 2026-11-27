import {
  compileProviders,
  selectCompiler,
} from "./vendor/cloud/compile-providers.mjs";
import {
  imageCatalog,
  imageRouteConfigured,
  keyframeImageRoute,
} from "./vendor/cloud/image-provider.mjs";
import {
  videoProviders,
  selectVideoRoute,
  videoKey,
} from "./vendor/cloud/video-providers.mjs";
import { RUNNINGHUB_DEPTH_WORKFLOW_ID } from "./vendor/cloud/runninghub-depth.mjs";
import {
  FAL_LIP_SYNC_MODEL,
  falLipSyncConfigured,
} from "./vendor/cloud/fal-lip-sync.mjs";

const source = (label, url) => `${label} · ${new URL(url).origin}`;
export function imageGenerationConfigured(config) {
  return imageCatalog(config).configured;
}
/** Deliberate safe projection: engine configuration contains credentials. */
export function aigcModelManagement(config, settings) {
  const compiler = selectCompiler(config, settings);
  const image = keyframeImageRoute(config);
  const video = selectVideoRoute(config, config.defaultVideoSelection);
  return [
    {
      id: "aigc_compile",
      model: compiler.model,
      selection: `${compiler.id}|${compiler.model}`,
      source: source(compiler.label, compiler.baseUrl),
      configured: !!compiler.apiKey,
      choices: compileProviders(config).filter(p => p.id !== "openrouter" && p.model).map((p) => ({
          value: `${p.id}|${p.model}`,
          label: `${p.label} · ${p.model}`,
          source: source(p.label, p.baseUrl),
          boundary: "脚本、分镜与视觉分析。",
          available: !!p.apiKey,
        })),
    },
    {
      id: "aigc_commerce_script",
      model: config.openrouterModel,
      selection: "",
      source: source("OpenRouter", config.openrouterBaseUrl || "https://openrouter.ai"),
      configured: !!config.openrouterApiKey,
      choices: [],
    },
    {
      id: "aigc_image",
      model: image.providerModel || image.model,
      selection: image.model,
      source: source(image.label, image.baseUrl),
      configured: imageRouteConfigured(config, image),
      choices: imageCatalog(config, "super_admin").models.map((m) => {
        const route = keyframeImageRoute(config, { modelId: m.id });
        return {
          value: m.id,
          label: m.label,
          source: source(route.label, route.baseUrl),
          boundary: `最多 ${m.maxImages} 张参考图。${m.detail}。独立 AgentAI 连接与目录就绪后可用，图片固定单张 2K。`,
          available: m.configured,
        };
      }),
    },
    {
      id: "aigc_video",
      model: video.model.model || video.model.id,
      selection: `${video.id}|${video.model.id}`,
      source: source(video.label, video.baseUrl),
      configured: !!videoKey(config, video),
      choices: videoProviders(config)
        .filter(
          (p) =>
            !config.enabledVideoProviders ||
            config.enabledVideoProviders.includes(p.id),
        )
        .flatMap((p) =>
          p.models
            .filter((m) => !m.legacy)
            .map((m) => {
              const route = selectVideoRoute(config, {
                providerId: p.id,
                modelId: m.id,
              });
              return {
                value: `${p.id}|${m.id}`,
                label: `${p.label} / ${m.label}`,
                source: source(p.label, p.baseUrl),
                boundary: `${m.note || "视频生成"}。${Math.min(...m.durations)}～${Math.max(...m.durations)} 秒，最多 ${m.maxImages} 张图片，画质 ${m.resolutions.join(" / ")}。${p.id === "bailian" ? "可按指定片段提交 CozyClay 灰模参考与整轨对白。百炼按秒和超额参考图计费，同框角色和口型须审片。" : p.id === "agentai" ? "AgentAI 仅接收图片参考，实际费用按供应商回执记录。" : "使用官方 xAI 视频。"}`,
                available: !!videoKey(config, route),
              };
            }),
        ),
    },
    {
      id: "aigc_depth",
      model: `工作流 ${config.runninghubWorkflowId || RUNNINGHUB_DEPTH_WORKFLOW_ID}`,
      selection: "",
      source: "RunningHub · https://www.runninghub.cn",
      configured: !!config.runninghubApiKey,
      choices: [],
    },
    {
      id: "aigc_lip_sync",
      model: FAL_LIP_SYNC_MODEL,
      selection: "",
      source: "fal · https://queue.fal.run",
      configured: falLipSyncConfigured(config),
      choices: [],
    },
    {
      id: "aigc_digitalhuman",
      model: "OpenTalking 网关指定模型",
      selection: "",
      source: config.opentalkingBaseUrl
        ? source("OpenTalking 网关", config.opentalkingBaseUrl)
        : "OpenTalking · 未配置网关",
      configured: !!(config.opentalkingBaseUrl && config.opentalkingApiKey),
      choices: [],
    },
  ];
}
