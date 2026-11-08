import { compileProviders, selectCompiler } from "./vendor/cloud/compile-providers.mjs";
import { imageCatalog, keyframeImageRoute } from "./vendor/cloud/image-provider.mjs";
import { videoProviders, selectVideoRoute, videoKey } from "./vendor/cloud/video-providers.mjs";
import { enhancementRoute } from "./vendor/cloud/video-enhance.mjs";
import { RUNNINGHUB_DEPTH_WORKFLOW_ID } from "./vendor/cloud/runninghub-depth.mjs";

const source = (label, url) => `${label} · ${new URL(url).origin}`;
/** Deliberate safe projection: engine configuration contains credentials. */
export function aigcModelManagement(config, settings) {
  const compiler = selectCompiler(config, settings);
  const image = keyframeImageRoute(config);
  const video = selectVideoRoute(config, config.defaultVideoSelection);
  const enhance = enhancementRoute(config.videoRelayBaseUrl);
  return [
    { id: "aigc_compile", model: compiler.model, selection: `${compiler.id}|${compiler.model}`, source: source(compiler.label, compiler.baseUrl), configured: !!compiler.apiKey,
      choices: compileProviders(config).flatMap(p => (p.models || []).map(m => ({ value: `${p.id}|${m.id}`, label: m.label, source: source(p.label, p.baseUrl), boundary: "脚本、分镜与视觉分析；星火线路仅限超级管理员。", available: p.id === "xylp" ? !!m.configured : !!p.apiKey }))) },
    { id: "aigc_image", model: image.model, selection: image.model, source: source(image.label, image.baseUrl), configured: !!videoKey(config, image),
      choices: imageCatalog(config, "super_admin").models.map(m => { const route = keyframeImageRoute(config, { modelId: m.id }); return { value: m.id, label: m.label, source: source(route.label, route.baseUrl), boundary: `最多 ${m.maxImages} 张参考图；${m.detail}。星火线路仅限超级管理员。`, available: m.configured }; }) },
    { id: "aigc_video", model: video.model.model || video.model.id, selection: `${video.id}|${video.model.id}`, source: source(video.label, video.baseUrl), configured: !!videoKey(config, video),
      choices: videoProviders(config).filter(p => !config.enabledVideoProviders || config.enabledVideoProviders.includes(p.id)).flatMap(p => p.models.filter(m => !m.legacy).map(m => { const route = selectVideoRoute(config, { providerId: p.id, modelId: m.id }); return { value: `${p.id}|${m.id}`, label: `${p.label} / ${m.label}`, source: source(p.label, p.baseUrl), boundary: `${m.note || "视频生成"}；${Math.min(...m.durations)}～${Math.max(...m.durations)} 秒；最多 ${m.maxImages} 张图片；画质 ${m.resolutions.join(" / ")}。${p.id === "bailian" ? "百炼按视频秒数及超额参考图片计费，实际金额以账单为准。" : "官方 xAI / 星火线路仅限超级管理员。"}`, available: !!videoKey(config, route) }; })) },
    { id: "aigc_enhance", model: "video-enhance", selection: "", source: source(enhance.label, enhance.baseUrl), configured: !!videoKey(config, enhance), choices: [] },
    { id: "aigc_depth", model: `工作流 ${config.runninghubWorkflowId || RUNNINGHUB_DEPTH_WORKFLOW_ID}`, selection: "", source: "RunningHub · https://www.runninghub.cn", configured: !!config.runninghubApiKey, choices: [] },
    { id: "aigc_digitalhuman", model: "OpenTalking 网关指定模型", selection: "", source: config.opentalkingBaseUrl ? source("OpenTalking 网关", config.opentalkingBaseUrl) : "OpenTalking · 未配置网关", configured: !!(config.opentalkingBaseUrl && config.opentalkingApiKey), choices: [] },
  ];
}
