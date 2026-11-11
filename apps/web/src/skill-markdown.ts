// 轻量 Markdown 解析：仅支持操作技能需要的标题、列表、引用、代码块、段落与行内粗体/代码。
// 解析成结构化数据后由 React 渲染，不使用 innerHTML。
export type SkillInline = { text: string; bold?: boolean; code?: boolean };
export type SkillBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4; inline: SkillInline[] }
  | { type: "list"; ordered: boolean; items: SkillInline[][] }
  | { type: "quote"; inline: SkillInline[] }
  | { type: "code"; text: string }
  | { type: "paragraph"; inline: SkillInline[] };

export function parseSkillInline(text: string): SkillInline[] {
  const out: SkillInline[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    if (match.index > last) out.push({ text: text.slice(last, match.index) });
    const token = match[0];
    out.push(
      token.startsWith("**")
        ? { text: token.slice(2, -2), bold: true }
        : { text: token.slice(1, -1), code: true },
    );
    last = match.index + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function parseSkillMarkdown(source: string): SkillBlock[] {
  const blocks: SkillBlock[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length)
      blocks.push({
        type: "paragraph",
        inline: parseSkillInline(paragraph.join(" ")),
      });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].trim().startsWith("```"))
        code.push(lines[i]);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    const item = /^(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(trimmed);
    if (!trimmed) flush();
    else if (heading) {
      flush();
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4,
        inline: parseSkillInline(heading[2]),
      });
    } else if (item) {
      flush();
      const ordered = !item[1];
      const prev = blocks.at(-1);
      const inline = parseSkillInline(item[3]);
      if (prev?.type === "list" && prev.ordered === ordered)
        prev.items.push(inline);
      else blocks.push({ type: "list", ordered, items: [inline] });
    } else if (trimmed.startsWith(">")) {
      flush();
      blocks.push({
        type: "quote",
        inline: parseSkillInline(trimmed.replace(/^>\s?/, "")),
      });
    } else paragraph.push(trimmed);
  }
  flush();
  return blocks;
}
