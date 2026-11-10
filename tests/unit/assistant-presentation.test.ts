import { describe, expect, it } from "vitest";
import {
  isPresentationToolName,
  parsePresentationCall,
  presentationMediaUrl,
  presentationRecordText,
  presentationText,
  presentationToolDefinitions,
  presentationToolNames,
  presentationToolResult,
  type PresentationDeck,
} from "../../packages/contracts/src/assistant-presentation.js";
import {
  cueDwellMs,
  initialPresentationState,
  presentationReducer,
  type PresentationState,
} from "../../apps/web/src/voice-presentation-state.js";

const origin = "https://erp.example.com";
const open = (args: unknown) => {
  const parsed = parsePresentationCall("present_slides", JSON.stringify(args), {
    origin,
    id: "deck-1",
  });
  if (!parsed.ok) throw Error(parsed.error);
  if (parsed.command.kind !== "open") throw Error("expected open");
  return parsed.command.deck;
};

describe("voice presentation contract", () => {
  it("advertises every tool with a matching definition", () => {
    expect(presentationToolDefinitions.map((tool) => tool.name)).toEqual([
      ...presentationToolNames,
    ]);
    expect(isPresentationToolName("present_slides")).toBe(true);
    expect(isPresentationToolName("workspace_request")).toBe(false);
  });

  it("parses a deck with charts, highlights and spotlights into plain text", () => {
    const deck = open({
      title: "<b>本周经营</b>",
      slides: [
        {
          title: "销售额走势",
          bullets: ["周三达到峰值", "<script>alert(1)</script>退货下降", ""],
          visual: {
            type: "chart",
            chart: "line",
            labels: ["周一", "周二", "周三"],
            series: [{ name: "销售额", values: [1200, "1,800", 2600] }],
            unit: "元",
          },
          seconds: 12,
        },
        {
          title: "退货率",
          visual: { type: "highlight", text: "3.2%", effect: "zoom" },
          cue: "再看退货",
        },
        {
          title: "库存预警",
          visual: { type: "spotlight", target: "库存明细" },
        },
      ],
    });
    expect(deck.title).toBe("本周经营");
    expect(deck.slides[0].bullets).toEqual(["周三达到峰值", "退货下降"]);
    expect(deck.slides[0].visual).toEqual({
      type: "chart",
      chart: "line",
      labels: ["周一", "周二", "周三"],
      series: [{ name: "销售额", values: [1200, 1800, 2600] }],
      unit: "元",
    });
    expect(deck.slides[0].seconds).toBe(12);
    expect(deck.slides[1].cue).toBe("再看退货");
    expect(deck.slides[2].cue).toBe("库存预警");
    expect(deck.slides[2].seconds).toBeGreaterThanOrEqual(6);
  });

  it("caps slide count and text length", () => {
    const deck = open({
      slides: Array.from({ length: 20 }, (_, i) => ({
        title: `第${i}页`.repeat(30),
        bullets: Array.from({ length: 10 }, () => "要点"),
      })),
    });
    expect(deck.slides).toHaveLength(12);
    expect(deck.slides[0].title.length).toBeLessThanOrEqual(40);
    expect(deck.slides[0].bullets).toHaveLength(6);
  });

  it("rejects malformed calls with a message the model can act on", () => {
    expect(parsePresentationCall("present_slides", "{oops")).toMatchObject({
      ok: false,
    });
    expect(parsePresentationCall("present_slides", "{}")).toMatchObject({
      ok: false,
    });
    expect(
      parsePresentationCall(
        "present_slides",
        JSON.stringify({
          slides: [{ title: "x", visual: { type: "chart", labels: ["a"] } }],
        }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("第1页") });
    expect(parsePresentationCall("goto_slide", '{"index":0}')).toMatchObject({
      ok: false,
    });
    expect(parsePresentationCall("goto_slide", '{"index":3}')).toEqual({
      ok: true,
      command: { kind: "goto", index: 2 },
    });
    expect(parsePresentationCall("next_slide", "")).toEqual({
      ok: true,
      command: { kind: "next" },
    });
    expect(parsePresentationCall("rm_rf", "{}")).toMatchObject({ ok: false });
  });

  it("only allows same-site media and the 唯品会 image CDN", () => {
    expect(presentationMediaUrl("/api/v1/aigc/assets/abc", "video")).toBe(
      "/api/v1/aigc/assets/abc",
    );
    expect(
      presentationMediaUrl(
        `${origin}/api/v1/aigc/assets/a?x=1`,
        "video",
        origin,
      ),
    ).toBe("/api/v1/aigc/assets/a?x=1");
    expect(
      presentationMediaUrl("https://a.vpimg2.com/upload/x.jpg", "image"),
    ).toBe("https://a.vpimg2.com/upload/x.jpg");
    expect(presentationMediaUrl("http://h2.appsimg.com/a/b.jpg", "image")).toBe(
      "https://h2.appsimg.com/a/b.jpg",
    );
    for (const bad of [
      "https://a.vpimg2.com/x.mp4",
      "https://evil.example.com/a.mp4",
      "//evil.example.com/a.jpg",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "/api/../../etc/passwd",
      "https://user:pw@a.vpimg2.com/x.jpg",
    ])
      expect(presentationMediaUrl(bad, "video", origin)).toBeNull();
    expect(
      presentationMediaUrl("https://evil.example.com/a.jpg", "image", origin),
    ).toBeNull();
    const parsed = parsePresentationCall(
      "present_slides",
      JSON.stringify({
        slides: [
          {
            title: "图",
            visual: { type: "image", url: "https://evil.example.com/a.jpg" },
          },
        ],
      }),
      { origin },
    );
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining("图片地址"),
    });
  });

  it("strips markup, control characters and provider names", () => {
    expect(
      presentationText("<img src=x onerror=1>你好\u0000\u202e世界", 20),
    ).toBe("你好世界");
    expect(presentationText("由 OpenAI 生成", 20)).toBe("由 智能服务 生成");
  });

  it("keeps a titles-only chat record and guides narration", () => {
    const deck = open({
      title: "复盘",
      slides: [{ title: "A" }, { title: "B" }],
    });
    expect(presentationRecordText(deck)).toBe(
      "【语音演示】复盘（共2页）：1. A；2. B",
    );
    expect(presentationToolResult({ kind: "open", deck })).toMatchObject({
      ok: true,
      total: 2,
      current: 1,
    });
    expect(presentationToolResult({ kind: "next" }).text).toContain("继续讲解");
  });
});

describe("voice presentation panel state", () => {
  const deck: PresentationDeck = {
    id: "d",
    title: "演示",
    slides: [
      { title: "开场", bullets: [], seconds: 5, cue: "开场" },
      { title: "销售额", bullets: [], seconds: 5, cue: "销售额" },
      { title: "退货率", bullets: [], seconds: 5, cue: "退货率" },
    ],
  };
  const opened = (): PresentationState =>
    presentationReducer(initialPresentationState, {
      type: "command",
      command: { kind: "open", deck },
    });

  it("opens, navigates within bounds and closes", () => {
    let s = opened();
    expect(s.index).toBe(0);
    s = presentationReducer(s, { type: "prev" });
    expect(s.index).toBe(0);
    s = presentationReducer(s, { type: "goto", index: 9 });
    expect(s.index).toBe(2);
    s = presentationReducer(s, { type: "next" });
    expect(s.index).toBe(2);
    s = presentationReducer(s, {
      type: "command",
      command: { kind: "goto", index: 1 },
    });
    expect(s.index).toBe(1);
    s = presentationReducer(s, { type: "close" });
    expect(s.deck).toBeUndefined();
  });

  it("auto-advances only while 小序 is speaking and not paused", () => {
    let s = opened();
    s = presentationReducer(s, { type: "tick", ms: 6000, speaking: false });
    expect(s.index).toBe(0);
    s = presentationReducer(s, { type: "tick", ms: 5000, speaking: true });
    expect(s.index).toBe(1);
    s = presentationReducer(s, { type: "pause" });
    s = presentationReducer(s, { type: "tick", ms: 9000, speaking: true });
    expect(s.index).toBe(1);
    s = presentationReducer(s, { type: "pause", paused: false });
    s = presentationReducer(s, { type: "tick", ms: 5000, speaking: true });
    s = presentationReducer(s, { type: "tick", ms: 50000, speaking: true });
    expect(s.index).toBe(2);
  });

  it("follows spoken cues in order, ignoring speech from before the deck opened", () => {
    let s = presentationReducer(initialPresentationState, {
      type: "transcript",
      id: "c1",
      text: "我先说下销售额和退货率，",
    });
    s = presentationReducer(s, {
      type: "command",
      command: { kind: "open", deck },
    });
    s = presentationReducer(s, {
      type: "tick",
      ms: cueDwellMs,
      speaking: true,
    });
    s = presentationReducer(s, {
      type: "transcript",
      id: "c1",
      text: "我先说下销售额和退货率，",
    });
    expect(s.index).toBe(0);
    s = presentationReducer(s, {
      type: "transcript",
      id: "c2",
      text: "先看销售额",
    });
    expect(s.index).toBe(1);
    // Saying the next cue right away does not skip a slide before it is seen.
    s = presentationReducer(s, {
      type: "transcript",
      id: "c2",
      text: "先看销售额，退货率",
    });
    expect(s.index).toBe(1);
    s = presentationReducer(s, {
      type: "tick",
      ms: cueDwellMs,
      speaking: true,
    });
    s = presentationReducer(s, {
      type: "transcript",
      id: "c2",
      text: "先看销售额，退货率，再说退货率",
    });
    expect(s.index).toBe(2);
  });

  it("keeps the last slide for review when the call ends", () => {
    let s = presentationReducer(opened(), { type: "next" });
    s = presentationReducer(s, { type: "call-ended" });
    expect(s).toMatchObject({ index: 1, ended: true, paused: true });
    s = presentationReducer(s, { type: "tick", ms: 60000, speaking: true });
    expect(s.index).toBe(1);
    s = presentationReducer(s, { type: "minimize" });
    expect(s.minimized).toBe(true);
    s = presentationReducer(s, { type: "next" });
    expect(s).toMatchObject({ index: 2, minimized: false });
  });
});
