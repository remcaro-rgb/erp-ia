"use client";

import { createContext, createElement, useContext, type ReactNode } from "react";
import { formatDay, formatDayTime } from "../date-format";
import { formatMoney } from "../money/format";

// The text of one value of a column, in ONE place for the grid's cells (`GridCell`) and the assistant's result tables
// (`ResultTable`): money as `$ 1.234.567,00`, dates and times in the company's time zone, Sí / No, option labels, and
// the grid's convention for nothing (null, empty text and a zero amount are a dash). Pure, so it is tested without a DOM.

export interface CellColumn {
  type: string;
  /** Labels of a closed set of values (enum, boolean, reference). */
  options?: readonly { value: string; label: string }[] | undefined;
}

export interface CellFormatOptions {
  yes: string;
  no: string;
  /** The company's time zone (IANA); the runtime's when absent. */
  timeZone?: string | undefined;
  /** A structured (`json`) value reads as a count ("3 líneas") instead of its raw text; the raw JSON goes in the cell's tooltip. */
  json?: ((count: number, kind: "items" | "fields") => string) | undefined;
}

/** True when the value shows as a dash: no value, empty text, or a zero amount. */
export function isEmptyCell(column: Pick<CellColumn, "type">, value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  return column.type === "money" && Number(value) === 0;
}

/** The text of `value` for `column` ("" for no value). */
export function formatCellValue(column: CellColumn, value: unknown, options: CellFormatOptions): string {
  if (value === null || value === undefined || value === "") return "";
  const label = (v: unknown) => column.options?.find((o) => o.value === String(v))?.label ?? String(v);
  // An empty structured value (no "otros impuestos") is no value: a dash, not "0 elementos", which read as a count of products.
  if (column.type === "json" && typeof value === "object" && (Array.isArray(value) ? value.length === 0 : Object.keys(value as object).length === 0)) return "";
  if (column.type === "json" && options.json && typeof value === "object") return Array.isArray(value) ? options.json(value.length, "items") : options.json(Object.keys(value as object).length, "fields");
  if (Array.isArray(value)) return value.map(label).join(", ");
  if (typeof value === "boolean") return column.options ? label(value) : value ? options.yes : options.no;
  if (column.type === "money") return formatMoney(value as number | string);
  if ((column.type === "datetime" || column.type === "date") && (typeof value === "string" || value instanceof Date)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : column.type === "date" ? formatDay(date, "UTC") : formatDayTime(date, options.timeZone);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return label(value);
}

interface CellFormatContextValue {
  timeZone?: string | undefined;
}
const CellFormatContext = createContext<CellFormatContextValue>({});

/** Gives every grid and result table below it the company's time zone. */
export function CellFormatProvider({ timeZone, children }: { timeZone?: string | undefined; children: ReactNode }) {
  return createElement(CellFormatContext.Provider, { value: { timeZone } }, children);
}

/** The company's time zone, when the shell provided it. */
export const useCellTimeZone = (): string | undefined => useContext(CellFormatContext).timeZone;
