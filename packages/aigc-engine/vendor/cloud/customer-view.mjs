import { videoCatalog, videoProviders, selectVideoRoute } from "./video-providers.mjs";
import { fail } from "./access.mjs";

export function customerProvider(config) {
  const provider = videoProviders(config).find(p => p.id === (config.publicVideoProvider || "xylp"));
  if (!provider || ["xai", "xhai"].includes(provider.id) || ["xai", "xhai"].includes(provider.protocol)) fail("平台视频服务暂不可用，请联系管理员", 503);
  return provider;
}

export function customerText(value, config) {
  if (typeof value !== "string") return value;
  let text = value.replace(/（中转站命名）/g, "");
  for (const provider of videoProviders(config)) {
    text = text.split(provider.label).join("平台视频服务");
    text = text.split(provider.baseUrl).join("平台服务");
    text = text.split(provider.keyEnv).join("服务配置");
  }
  return text.replace(/https?:\/\/[^\s"'<>）)]+/gi, "平台服务")
    .replace(/玄宇令牌|中转站|供应商|服务商/g, "平台服务")
    .replace(/OpenRouter|OpenAI|OPENROUTER_[A-Z_]+|OPENAI_[A-Z_]+/gi, "编译服务")
    .replace(/xAI(?: 官方)?|xylp|lk888/gi, "视频服务")
    .replace(/Railway(?: Variables)?/g, "云端配置");
}

export function catalogFor(user, config) {
  const catalog = videoCatalog(config);
  if (user.role === "super_admin") return catalog.map(provider => ({ ...provider, canViewSupplierDetails: true }));
  const provider = catalog.find(p => p.id === customerProvider(config).id);
  // Explicit capability allowlist: new upstream pricing/statistics fields must
  // never reach regular accounts by being spread into a public response.
  return [{ id: "platform", label: "平台视频服务", configured: provider.configured, canViewSupplierDetails: false, models: provider.models.map(m => ({
    id: m.id, label: customerText(m.label, config), group: m.group, configured: m.configured,
    durations: m.durations, durationsByResolution: m.durationsByResolution,
    maxImages: m.maxImages, resolutions: m.resolutions, aspects: m.aspects,
    note: customerText(m.note, config), inputMode: m.inputMode, minImageSide: m.minImageSide,
    mediaReferences: m.mediaReferences,
    roleBinding: m.roleBinding,
  })) }];
}

export function selectionForSave(user, config, selection) {
  if (user.role !== "super_admin" && selection?.providerId && selection.providerId !== "platform") fail("此视频服务仅限超级管理员使用，请重新选择可用模型", 403);
  const route = selectVideoRoute(config, user.role === "super_admin" ? selection : { ...selection, providerId: customerProvider(config).id });
  if (route.model.legacy) fail("旧模型已从新项目移除，请重新选择已分类模型", 400);
  return { providerId: route.id, modelId: route.model.id, resolution: route.resolution };
}

// Check again at the actual submission boundary: changing a role must not let
// a queued official xAI request bypass the public service restriction.
export function assertVideoAccess(data, userId, route) {
  if (!data.platform) return;
  const user = data.platform.users.find(u => u.id === userId && !u.disabled);
  if (!user) fail("账号已停用，不能提交新请求", 403);
  if ((!route || ["xai", "xhai"].includes(route.id) || ["xai", "xhai"].includes(route.protocol)) && user.role !== "super_admin") fail("此视频服务仅限超级管理员使用，请选择平台可用模型后重新生成", 403);
}

export function projectForClient(project, user, config) {
  if (user.role === "super_admin" || !project) return project;
  const value = structuredClone(project);
  if (value.videoSelection) {
    const allowed = value.videoSelection.providerId === customerProvider(config).id;
    value.videoSelection = allowed ? { ...value.videoSelection, providerId: "platform" } : { providerId: "restricted", modelId: "", resolution: "" };
  }
  if (value.imageSelection?.modelId?.startsWith("gt-image-2.5-")) value.imageSelection = { modelId: "tt-image-2.5-token" };
  return value;
}

// Only system-generated fields are rewritten; project notes, product evidence,
// filenames and user-supplied text stay intact.
export function taskForClient(task, user, config) {
  if (user.role === "super_admin" || !task) return task;
  return { ...task, title: customerText(task.title, config), currentItem: customerText(task.currentItem, config), error: customerText(task.error, config), logs: task.logs?.map(l => ({ ...l, message: customerText(l.message, config) })) };
}
export function reviewForClient(review, user, config) {
  if (user.role === "super_admin" || !review) return review;
  const restricted = review.imageService.model.startsWith("gt-image-2.5-");
  return { ...review, ...(review.imageModels ? { imageModels: review.imageModels.filter(model => !model.id.startsWith("gt-image-2.5-")) } : {}), frames: review.frames.map(({ cost, ...frame }) => ({ ...frame, ...(frame.imageModel?.startsWith("gt-image-2.5-") ? { imageModel: "restricted" } : {}) })), videoModelLabel: customerText(review.videoModelLabel, config), imageService: restricted ? { model: "restricted", label: "当前图片模型受限，请改选可用模型", detail: "", configured: false } : { model: review.imageService.model, label: review.imageService.label, detail: review.imageService.detail, configured: review.imageService.configured }, billing: review.billing && { ...review.billing, issue: customerText(review.billing.issue, config) } };
}
