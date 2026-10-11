import { z } from "zod";

/** Explicit edits use timezone-bearing timestamps and never clear record metadata. */
export const selectionCreatedTimeInputSchema = z.string().trim()
  .pipe(z.iso.datetime({ offset: true }))
  .refine(value => Number.isFinite(new Date(value).getTime()) && new Date(value).getUTCFullYear() >= 1, "请输入有效的创建时间")
  .transform(value => new Date(value).toISOString());

/** Human-entered / Excel dates use Beijing time; ISO input must carry its own timezone. */
export function parseSelectionCreatedTime(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  // Excel copies its displayed spelling (for example 2025/4/22 0:42), not
  // an ISO timestamp. Normalize the parts explicitly so host timezone and
  // permissive Date parsing cannot shift, swap or roll over the copied date.
  const local = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ \u00a0\u202f]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!local) {
    const parsed = selectionCreatedTimeInputSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  const padded = (part: string | undefined) => (part || "0").padStart(2, "0");
  const normalized = `${local[1]}-${padded(local[3])}-${padded(local[4])} ${padded(local[5])}:${padded(local[6])}:${padded(local[7])}`;
  const parsed = selectionCreatedTimeInputSchema.safeParse(`${normalized.replace(" ", "T")}+08:00`);
  return parsed.success && formatSelectionCreatedTime(parsed.data) === normalized ? parsed.data : null;
}

/** System timestamps use the same Beijing display in the UI and server queries. */
const selectionCreatedTimeFormatters = {
  date: new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }),
  datetime: new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }),
};

export function formatSelectionCreatedTime(value: unknown, timeDisplay: "date" | "datetime" = "datetime"): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) return "";
  const parts = selectionCreatedTimeFormatters[timeDisplay].formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value || "";
  const formatted = `${get("year")}-${get("month")}-${get("day")}`;
  return timeDisplay === "date" ? formatted : `${formatted} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export type SelectionCreatedTimeGroupUnit = "year" | "quarter" | "month" | "day";

/** Group the actual creation instant by Beijing calendar boundaries, independent of display settings. */
export function selectionCreatedTimeGroupLabel(value: unknown, unit: SelectionCreatedTimeGroupUnit): string {
  const parsed = typeof value === "string" ? parseSelectionCreatedTime(value) : null;
  const date = value instanceof Date ? value
    : typeof value === "number" && Number.isFinite(value) ? new Date(value)
      : parsed ? new Date(parsed) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1) return "";
  const [rawYear, month, day] = formatSelectionCreatedTime(date, "date").split("-");
  const year = rawYear.padStart(4, "0");
  switch (unit) {
    case "year": return `${year}年`;
    case "quarter": return `${year}年第${Math.ceil(Number(month) / 3)}季度`;
    case "month": return `${year}-${month}`;
    case "day": return `${year}-${month}-${day}`;
    default: return "";
  }
}
