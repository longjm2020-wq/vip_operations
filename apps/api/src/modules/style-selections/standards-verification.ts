// Only the standard number is sent to SAMR. Product facts and model-provided URLs
// never enter these requests. Official status verifies existence, not suitability.
export type StandardVerification = {
  status: "verified" | "invalid" | "not_found" | "inactive" | "unavailable";
  message: string;
  checkedAt: string;
  source?: { name: string; url: string };
};
const origin = "https://std.samr.gov.cn";
const cache = new Map<string, { until: number; result: StandardVerification }>();
const beijingDate = (time: number) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const clean = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
  .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
export const normalizeStandard = (value: string) => value.replace(/[—–－]/g, "-").replace(/\s+/g, " ").trim();
export function standardCode(value: string, kind: "safety" | "standard") {
  const normalized = normalizeStandard(value);
  const pattern = kind === "safety" ? /^(GB \d{2,6}(?:\.\d{1,3})?-\d{4}) [ABC]类$/u : /^([A-Z]{2,4}(?:\/T)? \d{2,6}(?:\.\d{1,3})?-\d{4})$/u;
  return normalized.match(pattern)?.[1];
}
const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
export function standardDetailUrl(html: string, code: string): string | undefined {
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tid = attribute(match[1], "tid"), id = attribute(match[1], "pid");
    if (!id || !/^[A-F0-9]{32}$/iu.test(id) || !["BV_GB", "BV_HB"].includes(tid || "")) continue;
    const displayedCode = match[2].match(/<span\b[^>]*class=["'][^"']*\ben-code\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
    if (!displayedCode || normalizeStandard(clean(displayedCode).replace(/\s*\/\s*/g, "/").replace(/(\d)\s*-\s*(\d)/g, "$1-$2")) !== code) continue;
    return `${origin}/${tid === "BV_HB" ? "hb/search/stdHBDetailed" : "gb/search/gbDetailed"}?id=${id}`;
  }
}
export function inspectStandardDetail(html: string, code: string, url: string, now = Date.now()): StandardVerification {
  const checkedAt = new Date(now).toISOString();
  const unavailable = { status: "unavailable" as const, checkedAt, message: "官方条目信息不完整，标准尚未核验；请稍后重新适配" };
  const page = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  const header = page.match(/<div\b[^>]*class=["'][^"']*\bpage-header\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  const name = header?.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1];
  const statuses = [...(header || "").matchAll(/<span\b[^>]*class=["'][^"']*\bs-status\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map(match => clean(match[1]));
  const values = new Map([...page.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)].map(match => [clean(match[1]), clean(match[2])]));
  const start = values.get("实施日期") || "";
  if (!name || normalizeStandard(values.get("标准号") || "") !== code || !/^\d{4}-\d{2}-\d{2}$/u.test(start) || !statuses.length) return unavailable;
  const source = { name: clean(name), url };
  const end = values.get("废止日期");
  if (!statuses.includes("现行") || statuses.some(value => /废止|即将实施|未实施/u.test(value)) || Date.parse(`${start}T00:00:00+08:00`) > now || (end && /^\d{4}-\d{2}-\d{2}$/u.test(end) && Date.parse(`${end}T00:00:00+08:00`) <= now))
    return { status: "inactive", checkedAt, source, message: "官方条目显示该版本已废止或尚未实施，不能采用；请重新适配现行版本" };
  return { status: "verified", checkedAt, source, message: "官方标准编号、名称及现行状态已核验；适用范围仍需结合本款资料核对" };
}
async function officialHtml(path: string, signal: AbortSignal): Promise<string> {
  // Both paths are built by this module; redirects and arbitrary destinations are forbidden.
  const url = new URL(path);
  if (url.origin !== origin || !["/search/stdPage", "/hb/search/stdHBDetailed", "/gb/search/gbDetailed"].includes(url.pathname)) throw new Error("Invalid standards destination");
  const response = await fetch(url, { redirect: "error", signal, headers: { Accept: "text/html" } });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html") || Number(response.headers.get("content-length") || 0) > 1_500_000) {
    await response.body?.cancel(); throw new Error("Unavailable standards response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty standards response");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1_500_000) throw new Error("Oversized standards response");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function verifyStandard(value: string, kind: "safety" | "standard", options: { fresh?: boolean; now?: number } = {}): Promise<StandardVerification> {
  const now = options.now ?? Date.now(), checkedAt = new Date(now).toISOString(), code = standardCode(value, kind);
  if (!code) return { status: "invalid", checkedAt, message: "AI 候选编号或安全类别格式不规范，未通过标准核验" };
  const key = `${kind}:${code}`, cached = cache.get(key);
  if (!options.fresh && cached && cached.until > now && beijingDate(Date.parse(cached.result.checkedAt)) === beijingDate(now)) return cached.result;
  let result: StandardVerification;
  try {
    const signal = AbortSignal.timeout(15000);
    const search = await officialHtml(`${origin}/search/stdPage?q=${encodeURIComponent(code)}&tid=`, signal);
    const url = standardDetailUrl(search, code);
    result = url ? inspectStandardDetail(await officialHtml(url, signal), code, url, now)
      : /class=["'][^"']*\ben-code\b/u.test(search)
        ? { status: "not_found", checkedAt, message: "官方检索未核验到此完整编号；保留 AI 分析供核对，暂不允许自动填入" }
        : { status: "unavailable", checkedAt, message: "官方检索未返回可核验的条目，已保留 AI 分析；请稍后重试" };
    if (result.status === "verified" && ((kind === "safety" && !/安全|有害物质/u.test(result.source!.name)) || (kind === "standard" && /安全技术|有害物质限量|试验方法|测定|测试方法/u.test(result.source!.name))))
      result = { ...result, status: "invalid", message: "此标准的用途与目标字段不符，不能作为该字段的适配结果" };
  } catch {
    result = { status: "unavailable", checkedAt, message: "官方标准核验服务暂不可用，已保留 AI 分析；请稍后重新适配，无需补填商品资料" };
  }
  if (cache.size >= 250) cache.delete(cache.keys().next().value!);
  cache.set(key, { until: now + (result.status === "verified" ? 10 * 60000 : 30000), result });
  return result;
}
