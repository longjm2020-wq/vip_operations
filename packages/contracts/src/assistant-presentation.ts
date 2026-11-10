import { z } from "zod";
import { assistantPublicText } from "./ai-presentation.js";
import { vipImageUrl } from "./competitor-analysis.js";

/**
 * Voice presentation ("演示面板") contract shared by the realtime voice prompt,
 * the server relay and the browser panel. The model only ever supplies plain
 * text, numbers and allow-listed media references; nothing is rendered as HTML.
 */
export const presentationToolNames = [
  "present_slides",
  "next_slide",
  "goto_slide",
  "close_presentation",
] as const;
export type PresentationToolName = (typeof presentationToolNames)[number];
export function isPresentationToolName(
  value: unknown,
): value is PresentationToolName {
  return presentationToolNames.some((name) => name === value);
}

export const presentationLimits = {
  slides: 12,
  bullets: 6,
  labels: 24,
  series: 4,
  title: 40,
  bullet: 90,
} as const;

/** Plain text only: strip markup, control characters and provider names. */
export function presentationText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return assistantPublicText(
    value
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/[<>]/g, "")
      .replace(
        /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g,
        "",
      )
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, max);
}

/**
 * Media may only come from this site (relative paths or the app origin) or the
 * 唯品会 image CDN already used across the product pages. Videos are same-site
 * only (AIGC assets, uploaded media). Never data:, blob:, javascript: or other hosts.
 */
export function presentationMediaUrl(
  value: unknown,
  kind: "image" | "video",
  origin?: string,
): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 2048 || /[\s\\<>"'`]/.test(raw)) return null;
  if (/^\/(?!\/)/.test(raw)) {
    try {
      const u = new URL(raw, "https://app.invalid");
      if (u.host !== "app.invalid" || /(^|\/)\.\.(\/|$)/.test(raw)) return null;
      return u.pathname + u.search;
    } catch {
      return null;
    }
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (origin) {
    try {
      if (u.origin === new URL(origin).origin) return u.pathname + u.search;
    } catch {
      /* Invalid origin configuration: treat as cross-site. */
    }
  }
  return kind === "image" ? vipImageUrl(raw) : null;
}

const visualTypes = [
  "image",
  "video",
  "chart",
  "highlight",
  "spotlight",
] as const;
const chartTypes = ["line", "bar", "pie"] as const;
const effects = ["pulse", "zoom", "reveal"] as const;

export type PresentationChart = {
  chart: (typeof chartTypes)[number];
  labels: string[];
  series: { name: string; values: number[] }[];
  unit?: string;
};
export type PresentationVisual =
  | { type: "image"; url: string; alt: string }
  | { type: "video"; url: string; alt: string }
  | ({ type: "chart" } & PresentationChart)
  | {
      type: "highlight";
      text: string;
      caption?: string;
      effect: (typeof effects)[number];
    }
  | { type: "spotlight"; target: string; caption?: string };
export type PresentationSlide = {
  title: string;
  bullets: string[];
  visual?: PresentationVisual;
  /** Spoken-time hint; the panel advances only while 小序 is speaking. */
  seconds: number;
  /** Phrase that, when 小序 says it, jumps to this slide. Defaults to title. */
  cue: string;
};
export type PresentationDeck = {
  id: string;
  title: string;
  slides: PresentationSlide[];
};
export type PresentationCommand =
  | { kind: "open"; deck: PresentationDeck }
  | { kind: "next" }
  | { kind: "goto"; index: number }
  | { kind: "close" };

const looseText = z.string().max(400);
const visualInput = z
  .object({
    type: z.enum(visualTypes),
    url: z.string().max(2048).optional(),
    alt: looseText.optional(),
    chart: z.enum(chartTypes).optional(),
    labels: z
      .array(z.union([z.string().max(60), z.number()]))
      .max(60)
      .optional(),
    series: z
      .array(
        z.object({
          name: z.string().max(60).optional(),
          values: z
            .array(z.union([z.number(), z.string().max(40), z.null()]))
            .max(60),
        }),
      )
      .max(8)
      .optional(),
    values: z
      .array(z.union([z.number(), z.string().max(40), z.null()]))
      .max(60)
      .optional(),
    unit: z.string().max(20).optional(),
    text: looseText.optional(),
    caption: looseText.optional(),
    effect: z.enum(effects).optional(),
    target: z.string().max(120).optional(),
  })
  .passthrough();
const slideInput = z
  .object({
    title: z.string().max(400),
    bullets: z.array(z.string().max(400)).max(12).optional(),
    visual: visualInput.nullish(),
    seconds: z.number().min(0).max(600).optional(),
    cue: z.string().max(120).optional(),
  })
  .passthrough();
const presentInput = z
  .object({
    title: z.string().max(400).optional(),
    slides: z.array(slideInput).min(1).max(30),
  })
  .passthrough();
const gotoInput = z.object({ index: z.coerce.number().int() }).passthrough();

function number(value: unknown) {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/[,，%¥￥\s]/g, ""))
        : NaN;
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

function chartVisual(
  v: z.infer<typeof visualInput>,
): (PresentationVisual & { type: "chart" }) | string {
  const chart = v.chart ?? "bar";
  const labels = (v.labels ?? [])
    .slice(0, presentationLimits.labels)
    .map((label) => presentationText(String(label), 16));
  const rawSeries = v.series?.length
    ? v.series
    : v.values
      ? [{ name: v.alt ?? "", values: v.values }]
      : [];
  const series = rawSeries
    .slice(0, chart === "pie" ? 1 : presentationLimits.series)
    .map((s, i) => ({
      name: presentationText(s.name ?? "", 16) || `系列${i + 1}`,
      values: labels.map((_, index) => number(s.values[index])),
    }));
  if (labels.length < (chart === "pie" ? 1 : 2) || !series.length)
    return "图表需要 labels（至少2项，饼图至少1项）和与之等长的 series[].values 数值";
  if (chart === "pie" && series[0].values.some((value) => value < 0))
    return "饼图数值不能为负数";
  return {
    type: "chart",
    chart,
    labels,
    series,
    ...(v.unit ? { unit: presentationText(v.unit, 8) } : {}),
  };
}

function visual(
  v: z.infer<typeof visualInput> | null | undefined,
  origin?: string,
): PresentationVisual | undefined | string {
  if (!v) return undefined;
  const alt = presentationText(v.alt ?? v.caption ?? "", 60);
  switch (v.type) {
    case "image":
    case "video": {
      const url = presentationMediaUrl(v.url, v.type, origin);
      if (!url)
        return v.type === "image"
          ? "图片地址不在允许范围：只能使用本站地址或唯品会商品图片地址"
          : "视频地址不在允许范围：只能使用本站地址（如生成的视频素材）";
      return { type: v.type, url, alt };
    }
    case "chart":
      return chartVisual(v);
    case "highlight": {
      const text = presentationText(v.text ?? "", 24);
      if (!text) return "highlight 需要 text（要强调的数字或关键词）";
      const caption = presentationText(v.caption ?? "", 60);
      return {
        type: "highlight",
        text,
        effect: v.effect ?? "pulse",
        ...(caption ? { caption } : {}),
      };
    }
    case "spotlight": {
      const target = presentationText(v.target ?? "", 40);
      if (!target) return "spotlight 需要 target（当前页面上可见的文字）";
      const caption = presentationText(v.caption ?? "", 60);
      return { type: "spotlight", target, ...(caption ? { caption } : {}) };
    }
  }
}

export function defaultSlideSeconds(slide: {
  title: string;
  bullets: string[];
}) {
  const chars = slide.title.length + slide.bullets.join("").length;
  return Math.min(40, Math.max(6, Math.ceil(chars / 4) + 4));
}

export type PresentationParseResult =
  { ok: true; command: PresentationCommand } | { ok: false; error: string };

/** Validate one model tool call. Arguments arrive as the provider's JSON string. */
export function parsePresentationCall(
  name: string,
  args: unknown,
  options: { origin?: string; id?: string } = {},
): PresentationParseResult {
  if (!isPresentationToolName(name))
    return { ok: false, error: "未知的演示工具" };
  let value: unknown = args;
  if (typeof args === "string") {
    if (args.length > 24000)
      return { ok: false, error: "演示内容过长，请减少页数或文字" };
    try {
      value = args.trim() ? JSON.parse(args) : {};
    } catch {
      return { ok: false, error: "演示参数不是合法 JSON，请重新生成完整对象" };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "演示参数必须是 JSON 对象" };
  if (name === "next_slide") return { ok: true, command: { kind: "next" } };
  if (name === "close_presentation")
    return { ok: true, command: { kind: "close" } };
  if (name === "goto_slide") {
    const parsed = gotoInput.safeParse(value);
    if (!parsed.success || parsed.data.index < 1)
      return { ok: false, error: "goto_slide 需要从1开始的页码 index" };
    return {
      ok: true,
      command: {
        kind: "goto",
        index: Math.min(parsed.data.index, presentationLimits.slides) - 1,
      },
    };
  }
  const parsed = presentInput.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      error: "present_slides 需要 slides 数组（1至12页），每页包含 title",
    };
  const slides: PresentationSlide[] = [];
  for (const [i, raw] of parsed.data.slides
    .slice(0, presentationLimits.slides)
    .entries()) {
    const title = presentationText(raw.title, presentationLimits.title);
    if (!title) return { ok: false, error: `第${i + 1}页缺少标题 title` };
    const bullets = (raw.bullets ?? [])
      .map((b) => presentationText(b, presentationLimits.bullet))
      .filter(Boolean)
      .slice(0, presentationLimits.bullets);
    const v = visual(raw.visual, options.origin);
    if (typeof v === "string")
      return { ok: false, error: `第${i + 1}页：${v}` };
    const hinted = raw.seconds ? Math.round(raw.seconds) : 0;
    slides.push({
      title,
      bullets,
      ...(v ? { visual: v } : {}),
      seconds: hinted
        ? Math.min(90, Math.max(3, hinted))
        : defaultSlideSeconds({ title, bullets }),
      cue: presentationText(raw.cue ?? "", 30) || title,
    });
  }
  return {
    ok: true,
    command: {
      kind: "open",
      deck: {
        id: options.id ?? randomId(),
        title:
          presentationText(parsed.data.title ?? "", presentationLimits.title) ||
          slides[0].title,
        slides,
      },
    },
  };
}
function randomId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now());
}

/** Compact, reviewable chat-history line for a deck (titles only). */
export function presentationRecordText(deck: PresentationDeck) {
  const pages = deck.slides
    .map((slide, i) => `${i + 1}. ${slide.title}`)
    .join("；");
  return `【语音演示】${deck.title}（共${deck.slides.length}页）：${pages}`.slice(
    0,
    1200,
  );
}

/** Text returned to the model so it narrates in step with the panel. */
export function presentationToolResult(
  command: PresentationCommand,
  state?: { index: number; total: number; title?: string },
) {
  if (command.kind === "open")
    return {
      ok: true,
      total: command.deck.slides.length,
      current: 1,
      text: `演示面板已打开，共${command.deck.slides.length}页，正在显示第1页《${command.deck.slides[0].title}》。现在按页顺序口头讲解，不要朗读页码或工具名；讲到下一页时先自然说出下一页的标题（或 cue），面板会随讲解自动翻页。不要再次调用 present_slides。`,
    };
  if (command.kind === "close") return { ok: true, text: "演示面板已关闭。" };
  if (!state) return { ok: true, text: "已切换演示页面，请继续讲解这一页。" };
  return {
    ok: true,
    current: (state?.index ?? 0) + 1,
    total: state?.total ?? 0,
    text: state?.total
      ? `已切换到第${state.index + 1}页《${state.title ?? ""}》，请继续讲解这一页。`
      : "当前没有打开的演示。",
  };
}

const visualSchema = {
  type: "object",
  description:
    "可选的演示画面。type=image/video 需 url（仅限本站地址如 /api/v1/aigc/assets/…，或唯品会商品图片地址；视频仅限本站）；type=chart 需 chart(line/bar/pie)、labels 与 series[{name,values}]，数值只用工具返回或页面上真实看到的数据；type=highlight 用 text 放大强调一个数字或关键词，effect 可选 pulse/zoom/reveal；type=spotlight 用 target 填当前页面上可见的一段文字，在页面上高亮该区域。",
  properties: {
    type: { type: "string", enum: [...visualTypes] },
    url: { type: "string" },
    alt: { type: "string", description: "画面的简短说明" },
    chart: { type: "string", enum: [...chartTypes] },
    labels: { type: "array", items: { type: "string" } },
    series: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          values: { type: "array", items: { type: "number" } },
        },
        required: ["values"],
      },
    },
    unit: { type: "string", description: "数值单位，如 元、件、%" },
    text: { type: "string" },
    caption: { type: "string" },
    effect: { type: "string", enum: [...effects] },
    target: { type: "string" },
  },
  required: ["type"],
};

/** Realtime function definitions (OpenAI style; Qwen wraps them in `function`). */
export const presentationToolDefinitions = [
  {
    type: "function",
    name: "present_slides",
    description:
      "在用户屏幕上弹出半透明演示面板，像讲PPT一样边讲边播放。用于讲解需要看图、看趋势或对比、看视频、或指出页面位置的内容（如经营数据走势、商品图片、操作步骤）。普通寒暄或一句话能说清的问题不要使用。每次讲解只调用一次，2至6页为宜，最多12页；页面文字要短（标题≤20字，每页≤4条要点），具体解释用语音说。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "演示主题" },
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              visual: visualSchema,
              seconds: {
                type: "number",
                description: "预计讲解这一页的秒数（3至90），用于自动翻页",
              },
              cue: {
                type: "string",
                description: "讲到这一页时你会说出的短语，默认为标题",
              },
            },
            required: ["title"],
          },
        },
      },
      required: ["slides"],
    },
  },
  {
    type: "function",
    name: "next_slide",
    description: "演示面板翻到下一页。用户说“下一页/继续”时使用。",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "goto_slide",
    description:
      "演示面板跳到指定页（从1开始）。用户说“上一页/回到第二页”时使用。",
    parameters: {
      type: "object",
      properties: { index: { type: "integer", minimum: 1 } },
      required: ["index"],
    },
  },
  {
    type: "function",
    name: "close_presentation",
    description: "关闭演示面板。讲解结束或用户要求关闭时使用。",
    parameters: { type: "object", properties: {} },
  },
] as const;

export const presentationInstructions =
  "需要讲解图文、数据走势或对比、商品图片、视频素材，或指出当前页面某个位置时，调用 present_slides 弹出演示面板，再像讲PPT一样逐页口头讲解：每页先说出该页标题或 cue，面板会随讲解自动翻页；也可按用户要求调用 next_slide、goto_slide、close_presentation。图表数值只能来自工具返回或页面上真实看到的数据，没有数据时先用业务或页面工具获取，不编造；图片和视频只用本站或唯品会商品图片地址，没有合适素材就只用文字、highlight 或 spotlight。面板文字简短，详细解释用语音。普通聊天不要打开演示。";
