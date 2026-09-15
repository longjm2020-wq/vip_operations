export function projectPeriod(start: string, end: string): string {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(value + "T00:00:00Z");
    return Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
      ? date
      : null;
  };
  const first = parse(start),
    last = parse(end);
  if (!first || !last || end < start) return "";
  const thursday = new Date(first);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const week = Math.ceil(
    ((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) /
      86400000 +
      1) /
      7,
  );
  const format = (date: Date) =>
    `${first.getUTCFullYear() !== last.getUTCFullYear() ? date.getUTCFullYear() + "." : ""}${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
  return `（第${week}周 ${format(first)}-${format(last)}）`;
}

export function projectBaseName(
  name: string,
  start: string,
  end: string,
): string {
  const suffix = projectPeriod(start, end);
  return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}
