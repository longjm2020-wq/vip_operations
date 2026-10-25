// Shared by the editor, quotation and worker. Unchecked groups never become
// generation references; bindings and measurements are part of the cache key.
const copy = value => structuredClone(value);
const meaningful = fields => (fields || []).some(f => String(f.value || "").trim());
export function getProjectCast(project) {
  if (project.cast) return project.cast;
  const roles = project.assets?.modelImages || [], products = project.assets?.productImages || [];
  return {
    roles: roles.length || meaningful(project.modelMeasurements) ? [{ id: "role-legacy", name: "角色 1", selected: true, images: roles, measurements: project.modelMeasurements || [] }] : [],
    products: products.length || meaningful(project.productMeasurements) ? [{ id: "product-legacy", name: "商品 1", selected: true, roleId: roles.length || meaningful(project.modelMeasurements) ? "role-legacy" : "", images: products, measurements: project.productMeasurements || [] }] : [],
  };
}
export function selectedCast(project) {
  const cast = getProjectCast(project);
  return { roles: cast.roles.filter(r => r.selected !== false), products: cast.products.filter(p => p.selected !== false) };
}
export function projectWithCast(project, cast) {
  const roles = cast.roles.filter(r => r.selected !== false), products = cast.products.filter(p => p.selected !== false);
  return { ...project, cast, assets: { ...project.assets, modelImages: roles.flatMap(r => r.images), productImages: products.flatMap(p => p.images) }, modelMeasurements: roles[0]?.measurements || [], productMeasurements: products[0]?.measurements || [] };
}
export function castIssue(project, requireLength = false) {
  const { roles, products } = selectedCast(project);
  if (!roles.length) return "请至少选择一个参与脚本的角色";
  if (!products.length) return "请至少选择一组参与脚本的商品";
  for (const role of roles) if (!role.images.length) return `请为“${role.name}”添加人物图片`;
  for (const product of products) {
    if (!product.images.length) return `请为“${product.name}”添加商品图片`;
    if (!roles.some(r => r.id === product.roleId)) return `请将“${product.name}”关联到一个已选角色`;
    if (requireLength && !project.assets.customInput && !product.measurements.some(f => /衣长|garment[ _-]*length/i.test(f.label) && String(f.value || "").trim())) return `请补充“${product.name}”的衣长实测`;
  }
  return "";
}
export function castFingerprint(project) {
  if (!project.cast) return undefined;
  const cast = selectedCast(project);
  const entry = item => ({ id: item.id, name: item.name, ...(item.roleId !== undefined ? { roleId: item.roleId } : {}), images: item.images.map(f => ({ path: f.path })), measurements: item.measurements });
  return { roles: cast.roles.map(entry), products: cast.products.map(entry) };
}
const measureText = fields => fields.filter(f => String(f.value || "").trim()).map(f => `${f.label}=${f.value}${f.unit || ""}`).join("；") || "未提供";
export function castScriptPlan(project) {
  const cast = selectedCast(project);
  return copy({ roles: cast.roles.map(({ id, name, measurements }) => ({ id, name, measurements })), products: cast.products.map(({ id, name, roleId, measurements }) => ({ id, name, role_id: roleId, measurements })) });
}
export function castInstructions(project) {
  if (!project.cast) return "";
  const { roles, products } = selectedCast(project);
  return `本项目已选角色与商品绑定（这是当前项目的唯一映射，覆盖旧模板中的人物与商品）：\n${roles.map(r => `角色 ${r.id}「${r.name}」；人物身型：${measureText(r.measurements)}`).join("\n")}\n${products.map(p => `商品组 ${p.id}「${p.name}」→ 角色 ${p.roleId}「${roles.find(r => r.id === p.roleId)?.name || "未关联"}」；商品实测：${measureText(p.measurements)}`).join("\n")}\n每个角色只使用自己的身份图和身型；每组商品只穿戴/展示在关联角色身上，不得交换角色、混用实测或拼接不同商品组的设计。同一角色关联多组商品时按镜头明确区分，不得合并为一件衣服。未选择的角色和商品不得加入脚本。`;
}
export function unitCastInstructions(project, unit) {
  if (!project.cast) return "";
  const cast = selectedCast(project);
  const roles = unit.character_ids || cast.roles.map(r => r.id), products = unit.product_ids || cast.products.map(p => p.id);
  return `${castInstructions(project)}\n本段出镜角色：${roles.join("、") || "无"}；本段展示商品组：${products.join("、") || "无"}。不得让本段列表之外的角色出镜，不得串穿商品。`;
}
export function normalizeUnitCast(project, unit) {
  if (!project?.cast) return {};
  const cast = selectedCast(project), multi = cast.roles.length > 1 || cast.products.length > 1;
  const ids = (value, allowed, label) => {
    if (value === undefined && !multi) return allowed;
    if (!Array.isArray(value) || value.length > 20 || value.some(id => typeof id !== "string" || !allowed.includes(id))) throw new Error(`编译片段的${label}缺失或不属于本项目，请核对脚本；未自动重新提交`);
    return [...new Set(value)];
  };
  const character_ids = ids(unit.character_ids, cast.roles.map(r => r.id), "角色编号");
  const product_ids = ids(unit.product_ids, cast.products.map(p => p.id), "商品组编号");
  if (cast.products.some(p => product_ids.includes(p.id) && !character_ids.includes(p.roleId))) throw new Error("编译片段中的商品与出镜角色关联不一致，请核对脚本；未自动重新提交");
  return { character_ids, product_ids };
}
