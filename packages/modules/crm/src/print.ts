import { defaultTemplate, type DefaultPresentation, type Template } from "@erp/kernel";
import { quoteEntity } from "./entities";

// The template a cotización prints with when the company chose none (entity types spec §6, ModuleDef.printTemplates): the kernel's
// letterhead and layout, with the commercial fields of the cotización only (number, customer, dates, amounts, notes) and a lines table of
// what a customer reads (product, description, quantity, price, discount, base, IVA, total). Labels are the caller's (the screen's, else
// the catalogue's: rule 24); what the caller may not see prints empty, as in every print.

/** The header fields a cotización prints, in this order. */
export const QUOTE_PRINT_FIELDS = ["number", "party_id", "issue_date", "valid_until", "currency", "subtotal", "discount_total", "tax_total", "total", "notes"];
/** The columns of its lines table, in this order. */
export const QUOTE_PRINT_LINE_COLUMNS = ["line_no", "product_id", "description", "qty", "unit_price", "discount_pct", "base", "iva", "total"];

export function quoteRecordTemplate(presentation: DefaultPresentation): Template {
  const byName = new Map(quoteEntity.fields.map((f) => [f.name, f]));
  const fields = QUOTE_PRINT_FIELDS.map((name) => byName.get(name)!);
  const base = defaultTemplate({ ...quoteEntity, fields }, "record", presentation);
  return { ...base, blocks: base.blocks.map((block) => (block.kind === "lines" ? { ...block, columns: QUOTE_PRINT_LINE_COLUMNS } : block)) };
}
