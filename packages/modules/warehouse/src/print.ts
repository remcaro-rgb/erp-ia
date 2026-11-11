import { defaultTemplate, type DefaultPresentation, type EntityDef, type Template } from "@erp/kernel";
import { packEntity } from "./entities";

// The «Lista de empaque» (plan 2B.2 Task 29.3, PG §4.3 step 6): what an empaque prints with when the company chose no template of its own
// (entity types spec §6, ModuleDef.printTemplates): the kernel's letterhead and layout with the empaque's number, alistamiento, pedido,
// customer, packages and weight, and a table of its packages (number, contents: product, lot or serial and quantity, weight, dimensions).
// Labels are the caller's (the screen's, else the catalogue's: rule 24); what the caller may not see prints empty, as in every print.

/** The header fields an empaque prints, in this order. */
export const PACK_PRINT_FIELDS = ["number", "pick_id", "order_id", "party_id", "warehouse_id", "packages_count", "total_weight_kg", "notes"];
/** The columns of its packages table, in this order. */
export const PACK_PRINT_LINE_COLUMNS = ["package_no", "contents", "weight_kg", "dimensions"];

/** The print of an empaque is titled «Lista de empaque» (catalogue `warehouse.print.pack_title`); the screen keeps «Empaque». */
export function packRecordTemplate(presentation: DefaultPresentation): Template {
  const title = presentation.t?.("warehouse.print.pack_title") ?? presentation.title;
  const byName = new Map(packEntity.fields.map((f) => [f.name, f]));
  const entity: EntityDef = { ...packEntity, fields: PACK_PRINT_FIELDS.map((name) => byName.get(name)!) };
  const base = defaultTemplate(entity, "record", title ? { ...presentation, title } : presentation);
  return { ...base, blocks: base.blocks.map((block) => (block.kind === "lines" ? { ...block, columns: [...PACK_PRINT_LINE_COLUMNS] } : block)) };
}
