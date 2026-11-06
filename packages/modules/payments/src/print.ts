import { defaultTemplate, type DefaultPresentation, type Template } from "@erp/kernel";
import { receiptEntity } from "./entities";

// The template a recibo de caja prints with when the company chose none (entity types spec §6, ModuleDef.printTemplates, plan 2B Task 24b,
// as sales' and invoicing's): the kernel's letterhead and layout with what the customer reads (number, customer, date, medio de pago, caja,
// reference, the money received, what it applied, the withholdings and the advance, the notes) and a table of what it applied to each
// invoice. Labels are the caller's (rule 24); what the caller may not see prints empty, as in every print.

/** The header fields a receipt prints, in this order. */
export const RECEIPT_PRINT_FIELDS = ["number", "party_id", "date", "method_id", "cash_box_id", "reference", "amount", "applied", "withholding_total", "advance", "notes"];
/** The columns of its allocations table, in this order. */
export const RECEIPT_PRINT_LINE_COLUMNS = ["line_no", "invoice_number", "amount", "withholding_total", "cash_amount"];

export function receiptRecordTemplate(presentation: DefaultPresentation): Template {
  const byName = new Map(receiptEntity.fields.map((f) => [f.name, f]));
  const base = defaultTemplate({ ...receiptEntity, fields: RECEIPT_PRINT_FIELDS.map((name) => byName.get(name)!) }, "record", presentation);
  return { ...base, blocks: base.blocks.map((block) => (block.kind === "lines" ? { ...block, columns: [...RECEIPT_PRINT_LINE_COLUMNS] } : block)) };
}
