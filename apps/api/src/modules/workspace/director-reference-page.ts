import { publicBrowserUrl } from "../../../../../packages/contracts/src/public-network.js";

export function shareTextUrl(text: string) {
  const value = text
    .match(/https?:\/\/[^\s<>"'，。；！？、（）【】《》]+/i)?.[0]
    .replace(/[),.;!\]\}]+$/, "");
  if (!value) throw Error("请粘贴包含公开作品链接的分享文本。");
  try {
    return publicBrowserUrl(value);
  } catch {
    throw Error("作品链接须为使用标准端口的公开 HTTP 或 HTTPS 地址。");
  }
}

function htmlText(text: string) {
  return text.replace(
    /&(amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi,
    (entity, key: string) => {
      const named: Record<string, string> = {
        amp: "&",
        quot: '"',
        apos: "'",
        lt: "<",
        gt: ">",
      };
      if (Object.hasOwn(named, key.toLowerCase()))
        return named[key.toLowerCase()];
      const code =
        key[1].toLowerCase() === "x"
          ? parseInt(key.slice(2), 16)
          : Number(key.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    },
  );
}

function attributes(tag: string) {
  const result = new Map<string, string>();
  for (const m of tag.matchAll(
    /\s+([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  )) {
    result.set(m[1].toLowerCase(), htmlText(m[2] ?? m[3] ?? m[4]));
  }
  return result;
}

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function douyinVideos(state: Dict, workId?: string) {
  const details: unknown[] = [
    state.aweme_detail,
    state.awemeDetail,
    ...list(state.item_list),
  ];
  for (const data of Object.values(dict(state.loaderData))) {
    const info = dict(dict(data).videoInfoRes);
    details.push(...list(info.item_list), info.aweme_detail);
  }
  for (const data of Object.values(state)) {
    const detail = dict(dict(data).aweme);
    details.push(detail.detail);
  }
  const post = details
    .map(dict)
    .find(
      (item) =>
        !!item.video &&
        (!workId || String(item.aweme_id ?? item.awemeId) === workId),
    );
  const video = dict(post?.video);
  const variants = [
    video.play_addr,
    video.playAddr,
    ...list(video.bit_rate).map((rate) => dict(rate).play_addr),
  ];
  return variants.flatMap((addr) => [
    ...list(dict(addr).url_list),
    ...list(dict(addr).urlList),
  ]);
}

function xhsVideos(state: Dict, workId?: string) {
  const note = dict(state.note),
    byId = dict(note.noteDetailMap);
  const firstId = workId || String(note.firstNoteId || "");
  const item = firstId ? byId[firstId] : Object.values(byId)[0];
  const streams = dict(dict(dict(dict(dict(item).note).video).media).stream);
  return ["h264", "h265", "av1"].flatMap((codec) =>
    list(streams[codec]).flatMap((stream) => {
      const entry = dict(stream);
      return [entry.masterUrl, ...list(entry.backupUrls)];
    }),
  );
}

function scriptState(text: string, encoded: boolean): Dict {
  try {
    const plain = (encoded ? decodeURIComponent(text.trim()) : text.trim())
      .replace(/^(?:window\.)?(?:_ROUTER_DATA|__INITIAL_STATE__)\s*=\s*/, "")
      .replace(/;\s*$/, "");
    // Public XHS page state uses the JavaScript literal undefined. Preserve quoted strings.
    const json = plain.replace(/"(?:\\.|[^"\\])*"|\bundefined\b/g, (token) =>
      token === "undefined" ? "null" : token,
    );
    return dict(JSON.parse(json));
  } catch {
    return {};
  }
}

export function socialWork(url: URL) {
  const douyin = /(^|\.)(douyin\.com|iesdouyin\.com)$/i.test(url.hostname);
  const xhs = /(^|\.)(xiaohongshu\.com|xhslink\.com)$/i.test(url.hostname);
  if (!douyin && !xhs) return null;
  const pathId = url.pathname.match(
    /\/(?:video|note|explore|item)\/([\da-z]+)(?:\/|$)/i,
  )?.[1];
  const id = pathId || (douyin ? url.searchParams.get("modal_id") : null);
  return { platform: douyin ? "douyin" : "xhs", id: id || undefined };
}

export function referencePageMedia(html: string, pageUrl: URL) {
  const work = socialWork(pageUrl);
  if (work && !work.id) return { urls: [], title: "" };
  const published: unknown[] = [],
    metadata: unknown[] = [],
    structured: unknown[] = [],
    elements: unknown[] = [];
  let videos = 0;
  let pageIdentified = false;
  let title = "";
  for (const match of html.matchAll(/<meta\b[^<>]*>/gi)) {
    const a = attributes(match[0]);
    const name = (a.get("property") || a.get("name") || "").toLowerCase();
    if (
      [
        "og:video",
        "og:video:url",
        "og:video:secure_url",
        "twitter:player:stream",
      ].includes(name)
    )
      metadata.push(a.get("content"));
    if (name === "og:title" && !title) title = a.get("content") || "";
    if (work && name === "og:url") {
      try {
        const declared = socialWork(new URL(a.get("content") || "", pageUrl));
        pageIdentified =
          !!declared &&
          declared.platform === work.platform &&
          declared.id === work.id &&
          !!a.get("content");
      } catch {
        /* Ignore malformed canonical metadata. */
      }
    }
  }
  const scripts = /<script\b([^<>]*)>/gi;
  const scriptEnd = /<\/script\s*>/gi;
  let open: RegExpExecArray | null;
  while ((open = scripts.exec(html))) {
    scriptEnd.lastIndex = scripts.lastIndex;
    const close = scriptEnd.exec(html);
    if (!close) break;
    const body = html.slice(scripts.lastIndex, close.index);
    scripts.lastIndex = scriptEnd.lastIndex;
    const attrs = attributes(open[1]),
      id = attrs.get("id");
    if (
      work?.platform === "douyin" &&
      (id === "RENDER_DATA" || /^\s*(?:window\.)?_ROUTER_DATA\s*=/.test(body))
    ) {
      published.push(
        ...douyinVideos(scriptState(body, id === "RENDER_DATA"), work.id),
      );
    } else if (
      work?.platform === "xhs" &&
      /^\s*(?:window\.)?__INITIAL_STATE__\s*=/.test(body)
    ) {
      published.push(...xhsVideos(scriptState(body, false), work.id));
    } else if (attrs.get("type")?.toLowerCase() === "application/ld+json") {
      try {
        const data = JSON.parse(body);
        for (const entry of [
          ...(Array.isArray(data) ? data : [data]),
          ...list(dict(data)["@graph"]),
        ]) {
          if (dict(entry)["@type"] === "VideoObject")
            structured.push(dict(entry).contentUrl);
        }
      } catch {
        /* Other structured data does not describe a video. */
      }
    }
  }
  for (const match of html.matchAll(
    /<video\b([^<>]*)>([\s\S]*?)(?:<\/video\s*>|$)/gi,
  )) {
    videos++;
    elements.push(attributes(match[1]).get("src"));
    for (const source of match[2].matchAll(/<source\b[^<>]*>/gi))
      elements.push(attributes(source[0]).get("src"));
  }
  if (!title)
    title = htmlText(
      html.match(/<title\b[^>]*>([^<]*)<\/title\s*>/i)?.[1] || "",
    );
  const urls = new Set<string>();
  // A login page, a recommendation feed and other videos alongside a post do
  // not identify a reference. Only accept alternate URLs for the same work.
  let candidates: unknown[] = [];
  if (work)
    candidates = published.length ? published : pageIdentified ? metadata : [];
  else if (metadata.length) candidates = metadata;
  else if (structured.length === 1) candidates = structured;
  else if (videos === 1 && !structured.length) candidates = elements;
  for (const value of candidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const link = publicBrowserUrl(new URL(value, pageUrl).href);
      if (link.href !== pageUrl.href) urls.add(link.href);
    } catch {
      /* Ignore non-public and inline media. */
    }
    if (urls.size === 4) break;
  }
  return { urls: [...urls], title: title.trim().slice(0, 120) };
}
