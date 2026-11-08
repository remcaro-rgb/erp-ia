// The name of a reference in a row (design §22.15, rule 21): next to a `ref` field, a grid page and the assistant's
// `kernel.data.query` carry `<field>_label`, the display field of the referenced record as the caller sees it, so the
// cell shows the record's name and links to its page. Browser-safe (the grid's cells read it).

/** The row key that names the record a `ref` field points to: `supplier_id` → `supplier_id_label`. */
export const refLabelKey = (field: string): string => `${field}_label`;

/**
 * The row key that says a `ref` field's record is readable to the caller although it has no name to show (its display field masked,
 * hidden or empty): `order_id` → `order_id_found`, set only then. A cell that has neither key names a record the caller cannot read.
 */
export const refFoundKey = (field: string): string => `${field}_found`;

/**
 * The text a display field gives a record's title or reference label. A `date` the driver returns as a `Date` (UTC midnight)
 * becomes `YYYY-MM-DD` (`YYYY-MM` for `displayFormat: "month"`), never the runtime's `toString`, so no time zone shifts the
 * day; a `datetime` becomes its ISO instant. The UI turns these into the company's reading (`formatLabel`).
 */
export function labelText(value: unknown, field?: { displayFormat?: "month" }): string {
  if (value instanceof Date) {
    const day = value.toISOString();
    if (field?.displayFormat === "month") return day.slice(0, 7);
    return day.endsWith("T00:00:00.000Z") ? day.slice(0, 10) : day;
  }
  const text = String(value);
  return field?.displayFormat === "month" && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 7) : text;
}
