// The name of a reference in a row (design §22.15, rule 21): next to a `ref` field, a grid page and the assistant's
// `kernel.data.query` carry `<field>_label`, the display field of the referenced record as the caller sees it, so the
// cell shows the record's name and links to its page. Browser-safe (the grid's cells read it).

/** The row key that names the record a `ref` field points to: `supplier_id` → `supplier_id_label`. */
export const refLabelKey = (field: string): string => `${field}_label`;
