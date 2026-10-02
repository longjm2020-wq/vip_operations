export type TrendPoint = { date: string; value: number | null };
export function calendarTrend(
  rows: { date: string; value: unknown }[],
  start: string,
  end: string,
): TrendPoint[] {
  const values = new Map(rows.map((row) => [row.date, row.value]));
  const points: TrendPoint[] = [];
  for (
    let time = Date.parse(start);
    time <= Date.parse(end) && points.length < 366;
    time += 86400000
  ) {
    const date = new Date(time).toISOString().slice(0, 10),
      value = values.get(date);
    points.push({
      date,
      value:
        value === null ||
        value === undefined ||
        value === "" ||
        !Number.isFinite(Number(value))
          ? null
          : Number(value),
    });
  }
  return points;
}
export function trendPath(
  points: TrendPoint[],
  x: (index: number) => number,
  y: (value: number) => number,
) {
  let started = false;
  return points
    .map((point, index) => {
      if (point.value === null) {
        started = false;
        return "";
      }
      const command = started ? "L" : "M";
      started = true;
      return `${command}${x(index)},${y(point.value)}`;
    })
    .join(" ");
}
export function trendDomain(points: TrendPoint[]) {
  const values = points.flatMap((point) =>
    point.value === null ? [] : [point.value],
  );
  const min = Math.min(0, ...values),
    max = Math.max(0, ...values);
  return { min, max: max === min ? min + 1 : max };
}
