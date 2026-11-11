import { defaultTemplate, type DefaultPresentation, type EntityDef, type Template } from "@erp/kernel";
import { commissionEntity, deliveryEntity, orderEntity, returnEntity } from "./entities";

// The templates a pedido, an entrega, a devolución and a comisión (Task 30.4) print with when the company chose none (entity types spec §6, ModuleDef.printTemplates, plan 2B
// Task 14b): the kernel's letterhead and layout with what the customer reads only (number, customer, dates, amounts or bodega, notes) and
// a lines table of the same. Labels are the caller's (the screen's, else the catalogue's: rule 24); what the caller may not see prints
// empty, as in every print. An entrega carries no prices: it is what left the bodega.

/** The header fields a pedido prints, in this order. */
export const ORDER_PRINT_FIELDS = ["number", "party_id", "issue_date", "delivery_date", "currency", "subtotal", "discount_total", "tax_total", "total", "notes"];
/** The columns of its lines table, in this order. */
export const ORDER_PRINT_LINE_COLUMNS = ["line_no", "product_id", "description", "qty", "unit_price", "discount_pct", "base", "iva", "total"];
/** The header fields an entrega prints. */
export const DELIVERY_PRINT_FIELDS = ["number", "order_id", "party_id", "date", "notes"];
/** Its lines table; `lots` is «Lote / Vence / Serie», what inventory issued of each lot and serial (Task 28.3), empty for an untracked line. */
export const DELIVERY_PRINT_LINE_COLUMNS = ["line_no", "product_id", "description", "qty", "lots"];
/** The header fields a devolución prints: what came back, from which entrega, and why. */
export const RETURN_PRINT_FIELDS = ["number", "delivery_id", "party_id", "date", "reason", "notes"];
export const RETURN_PRINT_LINE_COLUMNS = ["line_no", "product_id", "description", "qty"];
/** The header fields a commission prints (Task 30.4): who is owed, under which plan, from what, how much and when it is due. */
export const COMMISSION_PRINT_FIELDS = ["number", "date", "due_date", "payee_party_id", "payee_kind", "plan_id", "source_kind", "currency", "amount", "stage", "notes"];
export const COMMISSION_PRINT_LINE_COLUMNS = ["line_no", "amount"];

function template(entity: EntityDef, fieldNames: readonly string[], columns: readonly string[], presentation: DefaultPresentation): Template {
  const byName = new Map(entity.fields.map((f) => [f.name, f]));
  const fields = fieldNames.map((name) => byName.get(name)!);
  const base = defaultTemplate({ ...entity, fields }, "record", presentation);
  return { ...base, blocks: base.blocks.map((block) => (block.kind === "lines" ? { ...block, columns: [...columns] } : block)) };
}

export function orderRecordTemplate(presentation: DefaultPresentation): Template {
  return template(orderEntity, ORDER_PRINT_FIELDS, ORDER_PRINT_LINE_COLUMNS, presentation);
}

/** The print of an entrega is titled «Remisión de entrega» (catalogue `sales.print.delivery_title`, owner item 33); the screen keeps «Entrega». */
export function deliveryRecordTemplate(presentation: DefaultPresentation): Template {
  const title = presentation.t?.("sales.print.delivery_title") ?? presentation.title;
  return template(deliveryEntity, DELIVERY_PRINT_FIELDS, DELIVERY_PRINT_LINE_COLUMNS, title ? { ...presentation, title } : presentation);
}

export function returnRecordTemplate(presentation: DefaultPresentation): Template {
  return template(returnEntity, RETURN_PRINT_FIELDS, RETURN_PRINT_LINE_COLUMNS, presentation);
}

/** The print of a commission (Task 30.4, PG §5.5): the provision owed to its payee; its amounts print empty for who may not see them. */
export function commissionRecordTemplate(presentation: DefaultPresentation): Template {
  return template(commissionEntity, COMMISSION_PRINT_FIELDS, COMMISSION_PRINT_LINE_COLUMNS, presentation);
}
