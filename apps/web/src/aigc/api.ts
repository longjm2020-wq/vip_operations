import { csrf, queryClient } from "../api";
export type Item = Record<string, any>;
export const assetUrl = (id: string, download = false) =>
  `/api/v1/aigc/assets/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;
export async function studioApi(path: string, method = "GET", body?: unknown) {
  const form = body instanceof FormData;
  const response = await fetch(`/api/v1/aigc${path}`, {
    method,
    credentials: "include",
    headers: {
      ...(body && !form ? { "Content-Type": "application/json" } : {}),
      ...(method === "GET" ? {} : { "X-CSRF-Token": csrf }),
    },
    ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) queryClient.setQueryData(["me"], null);
    throw new Error(
      typeof value.error === "string"
        ? value.error
        : value.error?.message || "操作失败，请稍后重试",
    );
  }
  return value;
}
export const stateText: Record<string, string> = {
  draft: "草稿",
  queued: "排队中",
  running: "处理中",
  inflight: "生成中",
  waiting_provider: "服务处理中",
  done: "已完成",
  completed: "已完成",
  failed: "失败",
  paused: "已暂停",
  attention: "待核实",
  uncertain: "结果待核实",
  ended: "已结束",
  compiling: "拆解中",
  generating: "生成中",
  downloading: "保存中",
  saving: "保存中",
  starting: "准备中",
  ready: "已就绪",
  closed: "已结束",
  cancelled: "已取消",
  submitting: "提交中",
};
export const detailDraft = (framework = "detail-default") => ({
  name: "未命名电商项目",
  mode: "autonomous",
  outputTypes: [framework === "main-six" ? "main_image" : "detail_page"],
  outputRatios: { detail_page: "3:4", main_image: "1:1" },
  platform: "tmall",
  language: "zh-CN",
  imageModelId: "tt-image-2",
  frameworkId: framework,
  brand: { name: "", intro: "", tone: "", story: "" },
  person: { name: "", identityNotes: "" },
  product: {
    name: "",
    category: "",
    primaryColor: "",
    material: "",
    sellingPoints: [],
    truthFields: [],
  },
  assets: { brand: [], person: [], product: [], scene: [], templates: [] },
  modules: [],
  jobs: [],
  versions: [],
});
export const videoDraft = () => ({
  id: crypto.randomUUID(),
  name: "未命名短视频",
  sceneMode: "reference",
  replicationMode: "relative",
  videoAspectRatio: "9:16",
  modelMeasurements: [],
  productMeasurements: [],
  assets: {
    modelImages: [],
    productImages: [],
    sceneImages: [],
    referenceVideos: [],
    referenceAudios: [],
  },
  notes: "",
  saveReusableTemplate: true,
});
