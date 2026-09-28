/** One URL per line; preserve query strings, signed URL tokens and semicolons. */
export function selectionImageLinks(text: string): string[] {
  const values = text.trim().split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!values.length || values.some(value => { try { const url = new URL(value); return !["http:", "https:"].includes(url.protocol) || !!url.username || !!url.password || /\s/.test(value); } catch { return true; } })) return [];
  return [...new Set(values)];
}
export const invalidSelectionImage = "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100"><rect width="120" height="100" fill="#f5f5f5"/><g fill="none" stroke="#aaa" stroke-width="2"><rect x="43" y="20" width="34" height="28" rx="3"/><path d="M45 44l10-10 8 7 5-5 7 8M43 20l34 28"/></g><text x="60" y="71" text-anchor="middle" fill="#999" font-size="12" font-family="sans-serif">无效图片</text></svg>');
