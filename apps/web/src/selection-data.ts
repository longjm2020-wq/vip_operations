import { api } from "./api.js";
type Row = Record<string, any>;

export async function fetchSelectionRows(query: string, sort = "createdAt", direction = "asc", previous?: { data: Row[]; total: number; revision?: string }) {
  // During a rolling deployment the older API may not expose revision yet.
  const revision = await api("/style-selections/revision").then(result => result.data.revision as string).catch(() => undefined);
  if (revision && previous?.revision === revision) return previous;
  const data: Row[] = []; let total = 0;
  for (let page = 1; ; page++) {
    const response = await api("/style-selections?" + new URLSearchParams({ q: query, page: String(page), pageSize: "100", sort, direction }));
    if (page === 1) total = response.total;
    if (response.total !== total) throw Error("读取期间记录数发生变化，请刷新重试");
    data.push(...response.data);
    if (data.length >= total) break;
    if (!response.data.length) throw Error("资料未读取完整，请重试");
  }
  if (new Set(data.map(row => row.id)).size !== data.length) throw Error("读取期间记录发生变化，请刷新重试");
  return { data, total, revision };
}
