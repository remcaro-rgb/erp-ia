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
