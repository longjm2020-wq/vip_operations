import { fail } from "./access.mjs";
import {
  AGENTAI_ORIGIN,
  AGENTAI_IMAGES,
  agentaiConfigured,
  prepareAgentAi,
  submitAgentAi,
  pollAgentAi,
} from "./agentai-media.mjs";

export const IMAGE_MODELS = AGENTAI_IMAGES;
export const DEFAULT_IMAGE_MODEL = "agentai-gt-image-2.6-sunburst";

export function imageModelAvailable(id) {
  return IMAGE_MODELS.some((model) => model.id === id);
}

export function defaultImageModel(config = {}) {
  if (imageModelAvailable(config.keyframeImageModel))
    return config.keyframeImageModel;
  const candidates = [
    DEFAULT_IMAGE_MODEL,
    ...IMAGE_MODELS.map((model) => model.id),
  ];
  return (
    candidates.find((id) =>
      agentaiConfigured(config, imageModel({ model: id }).providerModel),
    ) ?? DEFAULT_IMAGE_MODEL
  );
}

export function imageModel(route = {}) {
  const model = IMAGE_MODELS.find(
    (item) => item.id === (route.model || DEFAULT_IMAGE_MODEL),
  );
  if (!model) fail("原图片模型已下线，请选择当前 AgentAI 图像模型", 409);
  return model;
}

export function keyframeImageRoute(config, selection) {
  const model = imageModel({
    model: selection?.modelId || defaultImageModel(config),
  });
  return {
    id: "keyframe-image",
    label: "AgentAI 图片",
    protocol: "agentai-image",
    baseUrl: AGENTAI_ORIGIN,
    keyEnv: "AGENTAI_API_KEY",
    model: model.id,
    providerModel: model.providerModel,
    preset: model.preset,
  };
}

function routeModel(route) {
  const model = IMAGE_MODELS.find((item) => item.id === route?.model);
  return route?.protocol === "agentai-image" &&
    route.baseUrl === AGENTAI_ORIGIN &&
    route.keyEnv === "AGENTAI_API_KEY" &&
    route.providerModel === model?.providerModel
    ? model
    : undefined;
}

function requireRoute(route) {
  const model = routeModel(route);
  if (!model)
    fail("原图片服务已下线或连接已变化，请核对原任务后再选当前模型", 409);
  return model;
}

export function imageRouteAvailable(route) {
  return Boolean(routeModel(route));
}

export function assertImageSelection(_user, route) {
  requireRoute(route);
}

export function assertImageAccess(data, userId, route) {
  if (
    data.platform &&
    !data.platform.users.some((item) => item.id === userId && !item.disabled)
  )
    fail("账号已停用，不能提交新请求", 403);
  requireRoute(route);
}

export function imageRouteConfigured(config, route) {
  const model = routeModel(route);
  return Boolean(model && agentaiConfigured(config, model.providerModel));
}

export function imageCatalog(config) {
  const models = IMAGE_MODELS.map(({ adapter, ...model }) => ({
    ...model,
    configured: agentaiConfigured(config, model.providerModel),
    priceKey: `keyframe/${model.id}/${model.preset}`,
  }));
  return {
    defaultModelId: defaultImageModel(config),
    configured: models.some((model) => model.configured),
    models,
  };
}

export function validateImageReferences(route, project, aspectRatio) {
  const model = requireRoute(route);
  const people = project.assets.modelImages.length;
  const products = project.assets.productImages.length;
  const count =
    people +
    products +
    (project.sceneMode === "custom" ? project.assets.sceneImages.length : 0);
  if (!people || !products || count > model.maxImages)
    throw new Error(
      `${model.label} 需要人物和商品原图，合计 2～${model.maxImages} 张；请精简素材或改选图像模型，也可上传已制作的关键帧`,
    );
  if (!model.aspects.includes(aspectRatio))
    throw new Error(
      `${model.label} 不支持 ${aspectRatio} 关键帧比例，请切换图像模型或上传对应比例的首帧`,
    );
}

export function keyframeImageBody(route, { prompt, images, aspectRatio }) {
  const model = requireRoute(route);
  if (images.length < 2 || images.length > model.maxImages)
    throw new Error(
      `关键帧自动生图需要 2～${model.maxImages} 张人物、商品与场景参考图；请调整素材或上传已制作的关键帧`,
    );
  if (!model.aspects.includes(aspectRatio))
    throw new Error("关键帧画幅不受当前图片服务支持");
  return {
    model_id: model.providerModel,
    modality: "image",
    operation: "generate",
    params: {
      prompt,
      images,
      mode: "multi-reference",
      count: 1,
      aspect_ratio: aspectRatio,
      [model.sizeField]: "2K",
      ...(model.quality
        ? { quality: model.quality, output_format: "png", moderation: "auto" }
        : {}),
    },
  };
}

export async function dryRunKeyframe(config, route, body) {
  requireRoute(route);
  Object.assign(body, await prepareAgentAi(config, body));
}

export async function submitKeyframe(config, route, body) {
  const model = requireRoute(route);
  if (body.model_id !== model.providerModel)
    fail("图片参数与任务绑定模型不同，请重新确认");
  return submitAgentAi(config, body);
}

export async function pollKeyframe(config, route, id) {
  return pollAgentAi(config, requireRoute(route).providerModel, "image", id);
}
