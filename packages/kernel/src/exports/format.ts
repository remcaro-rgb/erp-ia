import type { ExportColumn, WriterOptions } from "./types";

// What one value becomes in a file. Every writer asks `cellOf` for a typed cell and renders it its own way, so the
// rules (masking, money, dates, labels) live in one place.

/** What a masked field prints in every channel (rule 14). */
export const MASK = "••••••";

export type Cell =
  | { type: "empty" }
  | { type: "mask" }
  | { type: "number"; value: number; money: boolean }
  /** A calendar day, as a `Date` at UTC midnight. */
  | { type: "date"; value: Date }
  /** An instant (`at`) and the wall clock of the company's zone at that instant (`wall`, as UTC fields). */
  | { type: "datetime"; at: Date; wall: Date }
  | { type: "text"; value: string };

export const isSpanish = (locale: string | undefined): boolean => (locale ?? "es-419").toLowerCase().startsWith("es");

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim().replace(",", ".");
    return NUMERIC.test(text) ? Number(text) : null;
  }
  return null;
}

function dateOf(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.trim() !== "") {
    const date = new Date(DAY.test(value) ? `${value}T00:00:00Z` : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** The wall clock of `timeZone` at `instant`, as a `Date` whose UTC fields hold it (Excel has no time zones). */
export function wallClock(instant: Date, timeZone: string | undefined): Date {
  if (!timeZone) return instant;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
  } catch {
    return instant;
  }
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"), instant.getUTCMilliseconds()));
}

const yesNo = (value: boolean, locale: string | undefined) => (isSpanish(locale) ? (value ? "Sí" : "No") : value ? "Yes" : "No");

/** A value with its label from the column's options; a list joins its labels. */
function labelled(column: ExportColumn, value: unknown): string {
  const label = (v: unknown) => column.options?.[String(v)] ?? String(v);
  return Array.isArray(value) ? value.map(label).join(", ") : label(value);
}

/** The typed cell of one value of `column`. Empty values and values of an unexpected shape never throw. */
export function cellOf(column: ExportColumn, value: unknown, options: WriterOptions = {}): Cell {
  if (column.masked) return { type: "mask" };
  if (value === null || value === undefined || value === "") return { type: "empty" };
  switch (column.type) {
    case "money":
    case "number": {
      const n = numberOf(value);
      return n === null ? { type: "text", value: String(value) } : { type: "number", value: n, money: column.type === "money" };
    }
    case "date": {
      const d = dateOf(value);
      if (!d) return { type: "text", value: String(value) };
      return { type: "date", value: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) };
    }
    case "datetime": {
      const d = dateOf(value);
      return d ? { type: "datetime", at: d, wall: wallClock(d, options.timeZone) } : { type: "text", value: String(value) };
    }
    case "boolean": {
      const flag = value === true || value === "true" || value === "Sí";
      const known = typeof value === "boolean" || value === "true" || value === "false" || value === "Sí" || value === "No";
      return { type: "text", value: known ? (column.options?.[String(flag)] ?? yesNo(flag, options.locale)) : String(value) };
    }
    case "json":
      return { type: "text", value: typeof value === "string" ? value : JSON.stringify(value) };
    case "enum":
      return { type: "text", value: labelled(column, value) };
    default:
      return { type: "text", value: labelled(column, value) };
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
export const isoDay = (d: Date) => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const clock = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

/** ISO 8601 with the offset of `timeZone` at that instant (`2026-10-28T10:30:00-05:00`); `+00:00` without a zone. */
export function isoWithOffset(instant: Date, timeZone: string | undefined): string {
  const wall = wallClock(instant, timeZone);
  const minutes = Math.round((wall.getTime() - instant.getTime()) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const stamp = wall.toISOString().slice(0, 19);
  return `${stamp}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** `1.234.567,50` (es-CO) of an amount with two decimals. */
function grouped(amount: number): string {
  const cents = Math.round(Math.abs(amount) * 100);
  const units = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${units},${pad(cents % 100)}`;
}

/** `$ 1.234.567,00` (rule 23); a negative amount is `-$ 50,00`. */
export function moneyText(amount: number): string {
  const sign = amount < 0 && Math.round(Math.abs(amount) * 100) > 0 ? "-" : "";
  return `${sign}$ ${grouped(amount)}`;
}

/**
 * The text of one value as the file or the page prints it. `paper` is the PDF: money as `$ 1.234.567,00` and dates as
 * `dd/mm/yyyy`; without it, the plain form of CSV (money as a bare decimal, dates in ISO).
 */
export function cellText(column: ExportColumn, value: unknown, options: WriterOptions & { paper?: boolean } = {}): string {
  const cell = cellOf(column, value, options);
  switch (cell.type) {
    case "empty":
      return "";
    case "mask":
      return MASK;
    case "text":
      return cell.value;
    case "number": {
      if (options.paper && cell.money) return moneyText(cell.value);
      const text = cell.money ? cell.value.toFixed(2) : String(cell.value);
      return isSpanish(options.locale) ? text.replace(".", ",") : text;
    }
    case "date":
      return options.paper ? `${pad(cell.value.getUTCDate())}/${pad(cell.value.getUTCMonth() + 1)}/${cell.value.getUTCFullYear()}` : isoDay(cell.value);
    case "datetime":
      return options.paper
        ? `${pad(cell.wall.getUTCDate())}/${pad(cell.wall.getUTCMonth() + 1)}/${cell.wall.getUTCFullYear()} ${clock(cell.wall)}`
        : isoWithOffset(cell.at, options.timeZone);
  }
}

/** A text cell a spreadsheet could run as a formula (`= + - @`, or a tab / return before one) gets a `'` in front. */
export const defuse = (text: string): string => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
