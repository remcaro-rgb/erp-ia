// Dates read `AAAA/MM/DD` (owner decision 2026-10-31); a time follows as `HH:mm` on the 24-hour clock.

function parts(at: Date, timeZone: string | undefined, withTime: boolean): string {
  const format = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}), ...(timeZone ? { timeZone } : {}) });
  const get = (type: string) => format.formatToParts(at).find((p) => p.type === type)?.value ?? "";
  const day = `${get("year")}/${get("month")}/${get("day")}`;
  return withTime ? `${day} ${get("hour")}:${get("minute")}` : day;
}

/** `2026/10/31` of an instant in the company's zone (the runtime's when absent). */
export const formatDay = (at: Date | string, timeZone?: string): string => parts(new Date(at), timeZone, false);

/** `2026/10/31 14:05` of an instant in the company's zone. */
export const formatDayTime = (at: Date | string, timeZone?: string): string => parts(new Date(at), timeZone, true);

/**
 * A record's title or reference label as the kernel sends it (`labelText`): a bare `YYYY-MM-DD` reads `AAAA/MM/DD`, a bare
 * `YYYY-MM` reads as the month ("octubre de 2026"), an ISO instant in the company's zone; any other text is returned as is.
 */
export function formatLabel(text: string, locale = "es-419", timeZone?: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.replaceAll("-", "/");
  if (/^\d{4}-\d{2}$/.test(text)) {
    return new Date(`${text}-01T00:00:00Z`).toLocaleDateString(locale === "en" ? "en-US" : "es-CO", { month: "long", year: "numeric", timeZone: "UTC" });
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(text)) return formatDayTime(text, timeZone);
  return text;
}
