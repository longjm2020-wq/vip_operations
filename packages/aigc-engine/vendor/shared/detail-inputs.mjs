// Local extraction of supplied text only. Images never imply measurements or fabric claims.
export const DETAIL_ASSET_KINDS = ["person", "brand", "product", "scene"];
export const DETAIL_SCENES = ["智能适配", "纯色棚拍", "自然光室内", "城市街景", "自然户外"];
const aliases = {
  person: { name: ["人物名称", "姓名", "模特", "name"], identityNotes: ["人物说明", "身型说明", "identityNotes"], measurements: [] },
  brand: { name: ["品牌名称", "品牌名", "品牌", "name"], intro: ["品牌简介", "简介", "intro"], story: ["品牌故事", "故事", "story"], tone: ["品牌调性", "调性", "tone"] },
  product: { name: ["产品名称", "产品名", "商品名称", "商品名", "name"], category: ["品类", "类别", "category"], primaryColor: ["主色", "颜色", "primaryColor"], material: ["材质信息", "材质", "面料", "成分", "material"], sellingPoints: ["卖点", "sellingPoints"], truthFields: [] },
  scene: { name: ["场景名称", "场景", "name"], notes: ["场景说明", "说明", "notes"], preset: ["风格", "preset"] },
};
export function detailAssetName(filename) {
  return String(filename || "").replace(/\.[^.]+$/, "").replace(/[_-](?:正面|背面|侧面|人脸|全身|尺寸|资料|logo|front|back|\d+)$/i, "").slice(0, 80);
}
export function parseDetailDocument(kind, text) {
  if (!DETAIL_ASSET_KINDS.includes(kind)) throw new Error("不支持的资产类型");
  if (text.length > 100_000) throw new Error("资料文件最多 10 万字，请精简后上传");
  let json;
  try { json = JSON.parse(text); } catch { /* TXT / Markdown */ }
  if (json && typeof json === "object" && !Array.isArray(json)) json = json[kind] || json;
  else json = undefined;
  const result = {};
  for (const [key, names] of Object.entries(aliases[kind])) {
    const fromJson = json && [key, ...names].map(name => json[name]).find(value => value !== undefined);
    if (Array.isArray(fromJson) && ["measurements", "truthFields"].includes(key)) {
      result[key] = fromJson.filter(item => item && (item.name || item.label) && item.value !== undefined).slice(0, 50).map(item => ({ name: String(item.name || item.label).slice(0, 100), value: `${item.value}${item.unit || ""}`.slice(0, 500) }));
    } else if (key === "sellingPoints" && fromJson) {
      result[key] = (Array.isArray(fromJson) ? fromJson : String(fromJson).split(/[\n；;]/)).map(String).filter(Boolean).slice(0, 20);
    } else if (typeof fromJson === "string" || typeof fromJson === "number") result[key] = String(fromJson).slice(0, 10000);
    else if (names.length) {
      const allNames = Object.values(aliases[kind]).flat().join("|");
      const block = ["intro", "story", "identityNotes", "notes"].includes(key) ? `([\\s\\S]*?)(?=\\n\\s*(?:[-*]\\s*)?(?:${allNames})\\s*[：:=]|$)` : "([^\\n]+)";
      const match = text.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:${names.join("|")})\\s*[：:=]\\s*${block}`, "i"));
      if (match) result[key] = key === "sellingPoints" ? match[1].split(/[；;]/).filter(Boolean) : match[1].trim();
    }
  }
  if (kind === "person" || kind === "product") {
    const names = kind === "person" ? ["身高", "体重", "胸围", "腰围", "臀围", "肩宽"] : ["衣长", "裤长", "裙长", "肩宽", "胸围", "腰围", "臀围", "袖长", "尺码", "测量方式"];
    const key = kind === "person" ? "measurements" : "truthFields";
    const fields = result[key] || [];
    for (const name of names) {
      const value = json?.[name] ?? text.match(new RegExp(`(?:^|[\\s,，;；])${name}\\s*[：:=]?\\s*(.+?)(?=\\s*(?:${names.join("|")})\\s*[：:=]?|[\\n,，;；]|$)`, "im"))?.[1];
      if (value !== undefined && !fields.some(field => field.name === name)) fields.push({ name, value: String(value).trim().slice(0, 500) });
    }
    if (fields.length) result[key] = fields;
  }
  // Keep unlabeled supplied prose useful without inventing a brand story or product fact.
  if (!Object.keys(result).length && text.trim()) {
    if (kind === "brand") result.intro = text.trim().slice(0, 10000);
    if (kind === "person") result.identityNotes = text.trim().slice(0, 10000);
    if (kind === "scene") result.notes = text.trim().slice(0, 10000);
  }
  return result;
}
export function mergeDetailInformation(current, incoming) {
  const next = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) {
      const old = Array.isArray(next[key]) ? next[key] : [];
      next[key] = [...old, ...value.filter(item => !old.some(existing => typeof item === "string" ? existing === item : existing.name === item.name))];
    } else if (!next[key]) next[key] = value;
  }
  return next;
}
