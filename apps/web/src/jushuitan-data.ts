import { api } from "./api.js";
import { selectionLayoutSnapshotSchema } from "../../../packages/contracts/src/selection-layout.js";
import { jushuitanLimits, readJushuitanSources, type JushuitanMapping } from "./jushuitan-products.js";

export async function loadJushuitanSources(
  ids: string[], request: typeof api,
  references?: Record<string, { id: string; name: string }[]>,
) {
  if (!ids.length) throw Error("请关闭工具箱，勾选款式行或选中款号单元格后再打开");
  if (ids.length > jushuitanLimits.styles) throw Error(`一次最多选择 ${jushuitanLimits.styles} 款，请分批生成`);
  const layout = await request("/style-selections/layout-preferences?shared=true");
  const fields = selectionLayoutSnapshotSchema.parse(layout.data).preferences?.columns;
  if (!fields) throw Error("未读取到字段资料，请刷新表格后重试");
  const rows: Record<string, any>[] = [];
  // Bound requests; each detail is permission-projected by the existing table API.
  for (let offset = 0; offset < ids.length; offset += 4) {
    const batch = ids.slice(offset, offset + 4);
    const responses = await Promise.all(batch.map(id => request(`/style-selections/${encodeURIComponent(id)}`)));
    responses.forEach((response, index) => {
      if (!response.data || String(response.data.id) !== batch[index]) throw Error("所选记录已变化，请刷新后重新选择");
      rows.push(response.data);
    });
  }
  return readJushuitanSources(rows, fields, references);
}

export async function loadJushuitanMappings(request: typeof api = api) {
  const read = async (resource: string) => {
    const mappings: JushuitanMapping[] = [];
    let total = 0;
    for (let page = 1; ; page++) {
      const response = await request(`/${resource}?page=${page}&pageSize=100&status=ACTIVE`);
      if (!Array.isArray(response.data) || !Number.isInteger(response.total)) throw Error("颜色尺码映射读取不完整，请重试");
      if (page === 1) total = response.total;
      if (response.total !== total) throw Error("颜色尺码映射已变化，请重新读取");
      mappings.push(...response.data);
      if (mappings.length >= total) break;
      if (!response.data.length || page >= 100) throw Error("颜色尺码映射读取不完整，请重试");
    }
    if (new Set(mappings.map(item => item.code)).size !== mappings.length) throw Error("颜色尺码映射含重复编码，请刷新后重试");
    return mappings;
  };
  const [colors, sizes] = await Promise.all([read("color-mappings"), read("size-mappings")]);
  return { colors, sizes };
}
