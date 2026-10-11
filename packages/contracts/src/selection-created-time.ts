/** System timestamps use the same Beijing display in the UI and server queries. */
export function formatSelectionCreatedTime(value: unknown, timeDisplay: "date" | "datetime" = "datetime"): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    ...(timeDisplay === "date" ? {} : { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" as const }),
  }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value || "";
  const formatted = `${get("year")}-${get("month")}-${get("day")}`;
  return timeDisplay === "date" ? formatted : `${formatted} ${get("hour")}:${get("minute")}:${get("second")}`;
}
