// Public list-price snapshots, not account quotes. Never inherit rates by model ID
// alone: a different gateway may use an entirely different currency or tariff.
const checkedAt = "2026-09-27";
const relaySource = id => `https://xylp.ai/api/pricing?model=${id}`;
const line = (name, rates, imageRate = 0, freeImages = 0) => ({ name, rates, imageRate, freeImages });
const relay = {
  "hailuo-h3-quannengcankao": { source: relaySource(166), unit: "second", note: "DMC-default 仅提供 768P；本工作流只提交图片参考，无参考视频附加费。", lines: [line("DMC-default", { "768P": .1242 })] },
  "seedance-2.0-anmiao-quannengcankao": { source: relaySource(193), unit: "second", note: "官方特惠·标准版；仅含输出秒数，无参考视频。", lines: [line("官方特惠", { "480p": .4968, "720p": 1.1178, "1080p": 2.7945 })] },
  "seedance-2.5-anmiao-quannengcankao": { source: relaySource(195), unit: "second", note: "官方特惠；仅含输出秒数，无参考视频。", lines: [line("官方特惠", { "480p": .7037, "720p": 1.6974, "1080p": 4.3469 })] },
  "omni-1.1": { source: relaySource(204), unit: "request", note: "MC-omni-2 按时长与分辨率共同计费。", lines: [line("MC-omni-2", { "720P": Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 3, (i + 3) * .1242])), "1080P": Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 3, (i + 3) * .207])), "4K": Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 3, (i + 3) * .3105])) })] },
  "gk-video-3.5": { source: relaySource(119), unit: "second", note: "首帧图生视频，自带音频；MC 与 XT 均为同价，线路可用性会变化。", lines: [
    line("MC-GK1.5官转分组", { "480p": .207, "720p": .207 }),
    line("SC-默认分组", { "480p": .1656, "720p": .1656 }),
    line("XT-GK", { "480p": .207, "720p": .207 }),
  ] },
  "minimax-h3": { source: relaySource(206), unit: "second", note: "采用常规价，不计分时促销；部分线路每次请求前 5 张图片免费。", lines: [
    line("DMC-default", { "768P": .1242 }),
    line("RQ2 常规价", { "768P": .1242, "1080P": .2484, "2K": .2484, "4K": .3312 }, .414, 5),
    line("MC-H3特价", { "768P": .1656, "1080P": .3105, "2K": .3312, "4K": .3933 }),
    line("XM", { "768P": .7762, "2K": 1.2419 }, .3105, 5),
    line("TX", { "768P": .9315, "2K": 1.4904 }, .414, 5),
    line("官方直连", { "768P": 1.035, "2K": 1.656 }, .414, 5),
  ] },
  "seedance-2.5-guanfang": { source: relaySource(201), unit: "token", note: "使用不含参考视频档：当前只提交参考图片。实际按返回的 completion_tokens 结算。", lines: [
    line("官方特惠", { "480p": 69.552, "720p": 69.552, "1080p": 71.7256 }),
    line("XH", { "480p": 131.7141, "720p": 131.7141 }),
  ] },
  "kling-v3-omni-cankao": { source: relaySource(68), unit: "request", note: "按每段时长和品质逐次计费。", lines: [
    line("TX-Y3", { std: { 5: 4.1379, 10: 8.2758, 15: 12.4137 }, pro: { 5: 5.1724, 10: 10.3448, 15: 15.5171 } }),
    line("TX-Y5", { std: { 5: 4.968, 10: 9.936, 15: 14.904 }, pro: { 5: 6.21, 10: 12.42, 15: 18.63 } }),
  ] },
  "viduq3-turbo-cankaosheng": { source: relaySource(128), unit: "second", note: "按当前配置：错峰模式关闭。", lines: [line("Vidu-官方", { "540p": .2484, "720p": .3933, "1080p": .4761 })] },
  "omni_flash-10s": { source: relaySource(123), unit: "request", note: "固定 10 秒；线路参考图上限不同，实际可用线路以中转站为准。", lines: [line("zyg 系列", { "720p": { 10: 1.0557 } }), line("SC", { "720p": { 10: 1.656 } })] },
  "wan3.0-video-cankaosheng": { source: relaySource(186), unit: "second", note: "按当前配置：标准版。", lines: [line("官方直连", { "480P": .621, "720P": 1.242, "1080P": 2.484 })] },
};

export function pricingFor(route) {
  let price;
  if (route.protocol === "xai" && route.baseUrl === "https://api.x.ai/v1") {
    const rates = route.model.model === "grok-imagine-video-1.5" ? { "480p": .08, "720p": .14, "1080p": .25 } : route.model.model === "grok-imagine-video" ? { "480p": .05, "720p": .07 } : null;
    if (rates) price = { currency: "USD", source: "https://docs.x.ai/developers/pricing", unit: "second", note: "视频输出费 + 每次请求的参考图片费。", lines: [line("xAI 官方", rates, route.model.model.endsWith("1.5") ? .01 : .002)] };
  }
  if (route.protocol === "media" && route.baseUrl === "https://api.lk888.ai") {
    price = relay[route.model.model];
    // Rates describe the shipped request parameters, not arbitrary custom modes.
    if (route.model.model === "viduq3-turbo-cankaosheng" && route.model.params?.off_peak !== false) price = null;
    if (route.model.model === "seedance-2.0-anmiao-quannengcankao" && route.model.params?.version !== "标准") price = null;
    if (price && route.model.id === "gk-video-35") price = { ...price, lines: price.lines.filter(item => ["MC-GK1.5官转分组", "XT-GK"].includes(item.name)) };
    if (route.model.model === "wan3.0-video-cankaosheng" && route.model.params?.version !== "standard") price = null;
    if (price) price = { ...price, currency: "算力" };
  }
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
