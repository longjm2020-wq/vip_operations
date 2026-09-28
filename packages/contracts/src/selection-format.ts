import { z } from "zod";

export const numberFormatTypes = ["general", "number", "currency", "accounting", "date", "time", "percent", "fraction", "scientific", "text", "thousands", "special", "custom"] as const;
export const cellNumberFormatSchema = z.object({
  type: z.enum(numberFormatTypes),
  decimals: z.number().int().min(0).max(8).default(2),
  pattern: z.enum(["0", "0.00", "#,##0", "#,##0.00", "0%", "0.00%", "yyyy-MM-dd", "yyyy/M/d", "HH:mm:ss", "000000"]).default("0.00"),
}).strict();
export type CellNumberFormat = z.infer<typeof cellNumberFormatSchema>;

/** Display only: raw business values, identifiers and clipboard data remain intact. */
export function formatSelectionValue(value: unknown, format?: CellNumberFormat): string {
  const raw = String(value ?? "");
  if (!raw.trim() || !format || ["general", "text"].includes(format.type)) return raw;
  const pattern = format.type === "custom" ? format.pattern : "";
  if (format.type === "date" || pattern.startsWith("yyyy")) {
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return raw;
    const [, y, m, d] = match;
    const date = new Date(`${raw}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) return raw;
    return pattern === "yyyy/M/d" || format.type === "date" ? `${y}/${Number(m)}/${Number(d)}` : raw;
  }
  if (format.type === "time" || pattern === "HH:mm:ss") {
    const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match || +match[1] > 23 || +match[2] > 59 || +(match[3] || 0) > 59) return raw;
    return `${match[1].padStart(2, "0")}:${match[2]}:${match[3] || "00"}`;
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())) return raw;
  const number = Number(raw);
  // Never round long account numbers or other large identifiers through floating point.
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) return raw;
  const decimals = Math.min(8, Math.max(0, format.decimals ?? 2));
  const fixed = (n: number, digits = decimals, grouping = false) => Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: grouping }) : raw;
  if (format.type === "special" || pattern === "000000") return Number.isInteger(number) && number >= 0 ? String(number).padStart(6, "0") : raw;
  if (pattern) {
    if (pattern.endsWith("%")) return fixed(number * 100, pattern.includes(".") ? 2 : 0) + "%";
    return fixed(number, pattern.includes(".") ? 2 : 0, pattern.includes(","));
  }
  switch (format.type) {
    case "number": return fixed(number);
    case "currency": return "¥ " + fixed(number, decimals, true);
    case "accounting": return number === 0 ? "¥ —" : number < 0 ? `¥ (${fixed(-number, decimals, true)})` : "¥ " + fixed(number, decimals, true);
    case "percent": return fixed(number * 100) + "%";
    case "thousands": return fixed(number, decimals, true);
    case "scientific": return number.toExponential(decimals).toUpperCase();
    case "fraction": {
      const absolute = Math.abs(number), whole = Math.floor(absolute), rest = absolute - whole;
      let numerator = 0, denominator = 1, error = rest;
      for (let d = 1; d <= 100; d++) { const n = Math.round(rest * d), e = Math.abs(rest - n / d); if (e < error) { numerator = n; denominator = d; error = e; } }
      if (numerator === denominator) return String(number < 0 ? -(whole + 1) : whole + 1);
      return (number < 0 ? "-" : "") + (numerator ? `${whole ? whole + " " : ""}${numerator}/${denominator}` : String(whole));
    }
    default: return raw;
  }
}
