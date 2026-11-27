// Public list-price snapshots, not account quotes. Never inherit rates by model ID
// alone: a different gateway may use an entirely different currency or tariff.
const checkedAt = "2026-09-27";
const line = (name, rates, imageRate = 0, freeImages = 0) => ({ name, rates, imageRate, freeImages });
export function pricingFor(route) {
  let price;
  if (route.protocol === "xai" && route.baseUrl === "https://api.x.ai/v1") {
    const rates = route.model.model === "grok-imagine-video-1.5" ? { "480p": .08, "720p": .14, "1080p": .25 } : route.model.model === "grok-imagine-video" ? { "480p": .05, "720p": .07 } : null;
    if (rates) price = { currency: "USD", source: "https://docs.x.ai/developers/pricing", unit: "second", note: "视频输出费 + 每次请求的参考图片费。", lines: [line("xAI 官方", rates, route.model.model.endsWith("1.5") ? .01 : .002)] };
  }
  if (route.protocol === "bailian" && /^https:\/\/ws-[a-z0-9]+\.cn-beijing\.maas\.aliyuncs\.com\/api\/v1$/.test(route.baseUrl) && route.model.model === "MiniMax/MiniMax-H3") return { currency: "CNY", source: "https://help.aliyun.com/zh/model-studio/minimax-h3", checkedAt: "2026-11-08", unit: "second", note: "官方刊例预估，非实际账单；输入视频和输出视频按相同秒价，前 5 张图片免费。", lines: [line("百炼 MiniMax H3", { "768P": .5, "2K": .8 }, .2, 5)] };
  return price ? { ...price, checkedAt } : null;
}

export function quoteVideo(route, { durations, imageCount, aspectRatio, referenceVideoSeconds = 0, referenceAudioCount = 0 }) {
  const pricing = pricingFor(route);
  const result = { pricing, durations, imageCount, totals: null, issue: "" };
  if (!Number.isFinite(referenceVideoSeconds) || referenceVideoSeconds < 0 || !Number.isInteger(referenceAudioCount) || referenceAudioCount < 0) return { ...result, issue: "参考视频或音频计费信息无效" };
  if ((referenceVideoSeconds && !route.model.mediaReferences?.video) || (referenceAudioCount && !route.model.mediaReferences?.audio)) return { ...result, issue: "当前模型不支持所选视频或音频参考" };
  if (referenceVideoSeconds && (pricing?.unit !== "second" || !Number.isFinite(route.model.mediaReferences.video.priceMultiplier))) return { ...result, issue: "当前模型的参考视频附加费尚未配置" };
  if (pricing && route.model.mediaReferences?.video) pricing.note = `参考视频每次请求额外按其时长 × 输出秒单价的 ${route.model.mediaReferences.video.priceMultiplier * 100}% 计费；参考音频不另收费。`;
  if (!Array.isArray(durations) || !durations.length || durations.some(d => !Number.isFinite(d) || d <= 0)) return { ...result, issue: "读取原片时长或完成编译后显示项目预估。" };
  if (durations.some(d => !route.model.durations.includes(d))) return { ...result, issue: "当前分段时长不受该模型支持，不能按此计划生成；不会自动加长计费。" };
  const minImages = route.model.inputMode === "first-frame" ? 1 : 2;
  if (!Number.isInteger(imageCount) || imageCount < minImages || imageCount > route.model.maxImages) return { ...result, issue: minImages === 1 ? "该模型需要 1 张已验收首帧。" : `请配置人物和商品参考图；总数须为 2～${route.model.maxImages} 张。` };
  if (!route.model.aspects.includes(aspectRatio)) return { ...result, issue: "请确定该模型支持的画面比例后再估算费用。" };
  if (!pricing) return { ...result, issue: "此服务或模型尚无已核实价格，请查看服务商报价。" };
  let estimatedTokens, tokenAssumption;
  if (pricing.unit === "token") {
    const ratio = { "16:9": 16/9, "9:16": 9/16, "1:1": 1, "4:3": 4/3, "3:4": 3/4, "21:9": 21/9, "2:3": 2/3, "3:2": 3/2 }[aspectRatio];
    const side = { "480p": 480, "720p": 720, "1080p": 1080 }[route.resolution];
    if (!ratio || !side) return { ...result, issue: "确定画面比例后显示 Token 费用估算。" };
    const width = ratio >= 1 ? Math.round(side * ratio / 2) * 2 : side;
    const height = ratio >= 1 ? side : Math.round(side / ratio / 2) * 2;
    estimatedTokens = durations.reduce((s, d) => s + d, 0) * width * height * 24 / 1024;
    tokenAssumption = { width, height, fps: 24, source: "https://docs.volcengine.com/docs/ark/model-pricing?lang=zh" };
  }
  const totals = pricing.lines.flatMap(item => {
    const rate = item.rates[route.resolution];
    if (rate === undefined) return [];
    let output;
    if (pricing.unit === "request") {
      if (durations.some(d => rate[d] === undefined)) return [];
      output = durations.reduce((sum, d) => sum + rate[d], 0);
    } else output = pricing.unit === "token" ? estimatedTokens / 1e6 * rate : durations.reduce((s, d) => s + d, 0) * rate;
    const images = Math.max(0, imageCount - item.freeImages) * item.imageRate * durations.length;
    const videoReferences = referenceVideoSeconds * (route.model.mediaReferences?.video?.priceMultiplier || 0) * (typeof rate === "number" ? rate : 0) * durations.length;
    return [{ name: item.name, output, images, videoReferences, total: output + images + videoReferences }];
  });
  return totals.length ? { ...result, totals, estimatedTokens, tokenAssumption } : { ...result, issue: "当前画质暂无已核实价格。" };
}
