import type { CompassVisuals } from "./compass-ai-view.js";
export type CompassImageTarget = { image: string; code: string };

export function productReferenceTargets(visuals?: CompassVisuals) {
  const targets = new Map<string, CompassImageTarget>();
  visuals?.dimensions.forEach((d) =>
    d.top10.forEach((p) => {
      if (
        p.code &&
        p.image &&
        /^https:\/\//i.test(p.image) &&
        !targets.has(p.code)
      )
        targets.set(p.code, { code: p.code, image: p.image });
    }),
  );
  return [...targets.values()];
}
export function splitProductReferences(
  text: string,
  targets: CompassImageTarget[],
) {
  const index = new Map(targets.map((t) => [t.code, t]));
  if (!targets.length)
    return [{ text, target: undefined as CompassImageTarget | undefined }];
  const regex = new RegExp(
    [...index.keys()]
      .sort((a, b) => b.length - a.length)
      .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g",
  );
  const result: { text: string; target?: CompassImageTarget }[] = [];
  let position = 0;
  for (const m of text.matchAll(regex)) {
    const start = m.index,
      end = start + m[0].length;
    if (
      /[a-zA-Z0-9_-]/.test(text[start - 1] || "") ||
      /[a-zA-Z0-9_-]/.test(text[end] || "")
    )
      continue;
    if (start > position) result.push({ text: text.slice(position, start) });
    result.push({ text: m[0], target: index.get(m[0]) });
    position = end;
  }
  if (position < text.length) result.push({ text: text.slice(position) });
  return result;
}
