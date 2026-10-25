// Capabilities of our current adapters, not a promise of perfect identity fidelity.
// In particular the media gateway documents Vidu images[], NOT native subjects[].
export function videoRoleProfile(model = {}) {
  if (model.inputMode === "first-frame") return { mode: "first-frame", syntax: "frame", nativeSubjects: false, label: "多角色首帧", detail: "先在同一张首帧中确认各人物与商品，再生成视频；视频接口不接收独立角色原图。" };
  if (["sd20-omni", "sd25-omni", "seedance20", "seedance25"].includes(model.id)) return { mode: "references", syntax: "seedance", nativeSubjects: false, label: "多角色 · 编号图片绑定", detail: "按图片编号分别指定人物身份与商品归属；视频和音频仅按各自用途参考，不替换人物与商品。" };
  if (["h3-omni", "minimaxh3"].includes(model.id)) return { mode: "references", syntax: "h3", nativeSubjects: false, label: "多角色 · 多模态绑定", detail: "按 Image 编号区分人物、商品；动作与声音单独引用，禁止角色互换或服装迁移。" };
  if (["vidu-q3-turbo", "viduq3"].includes(model.id)) return { mode: "references", syntax: "ordinal", nativeSubjects: false, label: "多角色 · 多图分组", detail: "当前接入采用图片顺序与文字分组，不是原生主体分组接口；人物、商品、场景共用图片额度。" };
  return { mode: "references", syntax: "generic", nativeSubjects: false, label: "多角色 · 提示词绑定", detail: "以参考图顺序和角色商品对应说明进行绑定，模型可能出现身份或商品细节漂移。" };
}
