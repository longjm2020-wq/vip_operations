export function competitorCrawlProgress(job?: {
  capturedCount: number;
  detailCount: number;
}) {
  const count = (value: number) =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const captured = count(job?.capturedCount ?? 0);
  const details = Math.min(captured, count(job?.detailCount ?? 0));
  // One saved list item and one verified detail constitute the two work units
  // per product. A short list uses its actual length, never invented samples.
  const percent = captured
    ? Math.floor(((captured + details) / (captured * 2)) * 100)
    : 0;
  return { captured, details, percent };
}
