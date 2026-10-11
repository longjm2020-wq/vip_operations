import { z } from "zod";

/** Explicit edits use timezone-bearing timestamps and never clear record metadata. */
export const selectionCreatedTimeInputSchema = z.string().trim()
  .pipe(z.iso.datetime({ offset: true }))
  .refine(value => Number.isFinite(new Date(value).getTime()) && new Date(value).getUTCFullYear() >= 1, "请输入有效的创建时间")
  .transform(value => new Date(value).toISOString());

/** Human-entered dates use Beijing time; ISO input must carry its own timezone. */
export function parseSelectionCreatedTime(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  const local = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (!local) {
    const parsed = selectionCreatedTimeInputSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  const normalized = `${local[1]} ${local[2] || "00:00"}:${local[3] || "00"}`;
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
