import { api } from "./api.js";
type Row = Record<string, any>;

export async function fetchSelectionRows(query: string, sort = "createdAt", direction = "asc", previous?: { data: Row[]; total: number; revision?: string; tokens?: Record<string, string> }, request: typeof api = api, signal?: AbortSignal) {
  // During a rolling deployment the older API may not expose revision yet.
  const revision = await request("/style-selections/revision", "GET", undefined, undefined, { signal }).then(result => result.data.revision as string).catch(error => {
    if (signal?.aborted || [401,403,410].includes(error.status)) throw error;
    return undefined;
  });
  if (revision && previous?.revision === revision) return previous;
  try {
    const response = await request("/style-selections/sync", "POST", { q: query.slice(0, 100), sort, direction, known: previous?.tokens || {} }, undefined, { signal });
    const snapshot = response.data as { revision: string; index: { id: string; token: string }[]; data: Row[] };
    const records = new Map((previous?.data || []).map(row => [String(row.id), row]));
    for (const row of snapshot.data) records.set(String(row.id), row);
    const tokens: Record<string, string> = {};
    const data = snapshot.index.map(item => {
      if (!records.has(item.id) || tokens[item.id]) throw Error("同步资料不完整，请刷新重试");
      tokens[item.id] = item.token;
      return records.get(item.id)!;
    });
    return { data, total: data.length, revision: snapshot.revision, tokens };
  } catch (error) {
    // Only an older deployment without the endpoint falls back to paged reads.
    if (![404, 405].includes((error as { status?: number }).status || 0)) throw error;
  }
  const data: Row[] = []; let total = 0;
  for (let page = 1; ; page++) {
    const response = await request("/style-selections?" + new URLSearchParams({ q: query, page: String(page), pageSize: "100", sort, direction }), "GET", undefined, undefined, { signal });
    if (page === 1) total = response.total;
    if (response.total !== total) throw Error("读取期间记录数发生变化，请刷新重试");
    data.push(...response.data);
    if (data.length >= total) break;
    if (!response.data.length) throw Error("资料未读取完整，请重试");
  }
  if (new Set(data.map(row => row.id)).size !== data.length) throw Error("读取期间记录发生变化，请刷新重试");
  return { data, total, revision };
}
