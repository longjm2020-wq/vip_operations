type KnowledgeSection = { heading: string; excerpt: string };

const titleKey = (title: string) =>
  title.normalize("NFKC").trim().toLowerCase();

/** Only headings and wikilinks in Markdown prose describe the note's structure. */
export function indexKnowledgeMarkdown(content: string) {
  const wikiTitles = new Set<string>();
  const sections: KnowledgeSection[] = [];
  let heading = "",
    lines: string[] = [],
    fence = "";
  function flush() {
    const body = lines.join("\n").trim() || heading;
    const chars = Array.from(body);
    for (let i = 0; i < chars.length; i += 840) {
      sections.push({ heading, excerpt: chars.slice(i, i + 900).join("") });
      if (i + 900 >= chars.length) break;
    }
    lines = [];
  }
  for (const line of content.split(/\r\n?|\n/)) {
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (fence || marker) {
      if (!fence && marker) fence = marker[1];
      else if (marker && marker[1].startsWith(fence) && !marker[2].trim())
        fence = "";
      lines.push(line);
      continue;
    }
    const header = /^ {0,3}#{1,6}[ \t]+(.+?)\s*$/.exec(line);
    if (header) {
      flush();
      heading = Array.from(header[1].replace(/\s+#+\s*$/, "").trim())
        .slice(0, 160)
        .join("");
    } else {
      lines.push(line);
    }
    const prose = line.replace(/(\x60+).*?\1/g, "");
    for (const match of prose.matchAll(
      /(?<!\\)\[\[([^\[\]#|]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]*)?\]\]/g,
    )) {
      const title = titleKey(match[1].replace(/\.md$/i, ""));
      if (title && title.length <= 160) wikiTitles.add(title);
    }
  }
  flush();
  return { sections, wikiTitles: [...wikiTitles] };
}

export function resolveKnowledgeLinks(
  notes: { id: string; title: string; wiki_titles: string[] }[],
) {
  const targets = new Map<string, string | null>();
  for (const note of notes) {
    const key = titleKey(note.title);
    targets.set(key, targets.has(key) ? null : note.id);
  }
  return notes.flatMap((note) =>
    note.wiki_titles.flatMap((title) => {
      const targetId = targets.get(title);
      return targetId && targetId !== note.id
        ? [{ sourceId: note.id, targetId }]
        : [];
    }),
  );
}
