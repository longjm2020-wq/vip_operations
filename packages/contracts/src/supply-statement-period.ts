export function statementPeriod(mode: string, year: number, period: number) {
  const first =
    mode === "year" ? 1 : mode === "quarter" ? (period - 1) * 3 + 1 : period;
  const last = mode === "year" ? 12 : mode === "quarter" ? first + 2 : first;
  const from =
    String(year).padStart(4, "0") +
    "-" +
    String(first).padStart(2, "0") +
    "-01";
  const to = new Date(Date.UTC(year, last, 0)).toISOString().slice(0, 10);
  return { from, to };
}
