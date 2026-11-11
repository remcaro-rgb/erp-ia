// The entities that open as a full page at /r/<entity>/<id> (design §5.16) and how to read them. Pure, so
// the page stays thin and the rules are unit-tested.

export interface RecordEntity {
  id: string;
  /** The consult process that returns the record as the caller may see it. */
  consult: string;
  /** The processes the Datos form saves through (rule 1). Empty: the entity has no such form (a Período is only shown; a Regla contable or Plantilla is created elsewhere). */
  create: string;
  update: string;
  /** Column of the consult row that names the record in the frame's title. */
  titleField: string;
  /** i18n key of the entity's noun for "Crear <entity>" (`nav.create.*`). */
  nounKey: string;
  /** False: the grid offers no Importar (a DIAN document is never imported: it is issued). Default true. */
  importable?: boolean;
  /**
   * A parametro keyed by another of its fields (Task 28.5: a seguimiento por producto is one row per product): its consult takes that key,
   * read as the caller from `view` by the record's id, and its one save process takes no id. Such a record offers no «Duplicar» (one row
   * per key) and its Datos adicionales are not written through the save process (it takes no extra data).
   */
  keyedBy?: { view: string; column: string; input: string };
}

const RECORD_ENTITIES: readonly RecordEntity[] = [
  { id: "core.party", consult: "core.party.consult", create: "core.party.create", update: "core.party.update", titleField: "legal_name", nounKey: "nav.create.core.party" },
  { id: "core.product", consult: "core.product.consult", create: "core.product.create", update: "core.product.update", titleField: "description", nounKey: "nav.create.core.product" },
  {
    id: "core.product_category",
    consult: "core.category.consult",
    create: "core.category.create",
    update: "core.category.update",
    titleField: "name",
    nounKey: "nav.create.core.category",
  },
  // Comprobantes (accounting design §4.6, §8): the header and the lines are one record, saved by the draft processes; the number
  // is assigned on posting, so a draft has none yet.
  {
    id: "accounting.entry",
    consult: "accounting.entry.consult",
    create: "accounting.entry.create",
    update: "accounting.entry.update",
    titleField: "number",
    nounKey: "nav.create.accounting.entry",
  },
  // The accounting masters (accounting design §8, Task 28): the Cuenta, the four analytic nodes, the Fuente, the Plantilla de comprobante, the
  // Período and the Regla contable. A record with no create process has no `/new` form and no "Duplicar".
  { id: "accounting.account", consult: "accounting.account.consult", create: "accounting.account.create", update: "accounting.account.update", titleField: "code", nounKey: "nav.create.accounting.account" },
  { id: "accounting.cost_center", consult: "accounting.cost_center.consult", create: "accounting.cost_center.create", update: "accounting.cost_center.update", titleField: "name", nounKey: "nav.create.accounting.cost_center" },
  {
    id: "accounting.open_auxiliary",
    consult: "accounting.open_auxiliary.consult",
    create: "accounting.open_auxiliary.create",
    update: "accounting.open_auxiliary.update",
    titleField: "name",
    nounKey: "nav.create.accounting.open_auxiliary",
  },
  { id: "accounting.item", consult: "accounting.item.consult", create: "accounting.item.create", update: "accounting.item.update", titleField: "name", nounKey: "nav.create.accounting.item" },
  {
    id: "accounting.business_unit",
    consult: "accounting.business_unit.consult",
    create: "accounting.business_unit.create",
    update: "accounting.business_unit.update",
    titleField: "name",
    nounKey: "nav.create.accounting.business_unit",
  },
  { id: "accounting.journal", consult: "accounting.journal.consult", create: "accounting.journal.create", update: "accounting.journal.update", titleField: "code", nounKey: "nav.create.accounting.journal" },
  { id: "accounting.entry_template", consult: "accounting.entry_template.consult", create: "", update: "accounting.entry_template.update", titleField: "name", nounKey: "nav.create.accounting.entry_template" },
  { id: "accounting.period", consult: "accounting.period.consult", create: "", update: "", titleField: "starts_on", nounKey: "nav.create.accounting.period" },
  { id: "accounting.posting_rule", consult: "accounting.posting_rule.consult", create: "", update: "accounting.posting_rule.update", titleField: "name", nounKey: "nav.create.accounting.posting_rule" },
  // Inventory and costing (plan 2B Task 10): the bodega and the ubicación are maestros saved by their create and update processes; a
  // movimiento, traslado, conteo or costo en destino is created by the process that moves the stock (or the cost layers) and never
  // changes afterwards (no update: Anular, Despachar, Recibir, Registrar and Aplicar are their own steps).
  { id: "inventory.warehouse", consult: "inventory.warehouse.consult", create: "inventory.warehouse.create", update: "inventory.warehouse.update", titleField: "name", nounKey: "nav.create.inventory.warehouse" },
  { id: "inventory.location", consult: "inventory.location.consult", create: "inventory.location.create", update: "inventory.location.update", titleField: "name", nounKey: "nav.create.inventory.location" },
  { id: "inventory.movement", consult: "inventory.movement.consult", create: "inventory.movement.post", update: "", titleField: "number", nounKey: "nav.create.inventory.movement" },
  { id: "inventory.transfer", consult: "inventory.transfer.consult", create: "inventory.transfer.create", update: "", titleField: "number", nounKey: "nav.create.inventory.transfer" },
  { id: "inventory.count", consult: "inventory.count.consult", create: "inventory.count.create", update: "", titleField: "number", nounKey: "nav.create.inventory.count" },
  // Lotes, seriales and seguimiento por producto (plan 2B.2 Task 28.5): the lote and the serial are maestros saved by their create and update
  // (a serial's status is the movements'); a seguimiento is one row per product, created or changed by inventory.product_tracking.set
  // (step-up) and read by its consult, which takes the product.
  { id: "inventory.lot", consult: "inventory.lot.consult", create: "inventory.lot.create", update: "inventory.lot.update", titleField: "code", nounKey: "nav.create.inventory.lot" },
  { id: "inventory.serial", consult: "inventory.serial.consult", create: "inventory.serial.create", update: "inventory.serial.update", titleField: "serial_no", nounKey: "nav.create.inventory.serial" },
  {
    id: "inventory.product_tracking",
    consult: "inventory.product_tracking.consult",
    create: "inventory.product_tracking.set",
    update: "inventory.product_tracking.set",
    titleField: "product_id",
    nounKey: "nav.create.inventory.product_tracking",
    keyedBy: { view: "inventory.v_product_tracking", column: "product_id", input: "productId" },
  },
  { id: "costing.landed_cost", consult: "costing.landed_cost.consult", create: "costing.landed_cost.allocate", update: "", titleField: "number", nounKey: "nav.create.costing.landed_cost" },
  // CRM and Ventas (plan 2B Task 14b): the prospecto and the embudo are maestros, the cotización and the pedido documentos edited while they
  // are open; an oportunidad, an entrega and a devolución are created and then move only through their steps (no update here), and an
  // actividad is logged once (sistema).
  { id: "crm.lead", consult: "crm.lead.consult", create: "crm.lead.create", update: "crm.lead.update", titleField: "name", nounKey: "nav.create.crm.lead" },
  { id: "crm.pipeline", consult: "crm.pipeline.consult", create: "crm.pipeline.create", update: "crm.pipeline.update", titleField: "name", nounKey: "nav.create.crm.pipeline" },
  { id: "crm.opportunity", consult: "crm.opportunity.consult", create: "crm.opportunity.create", update: "", titleField: "number", nounKey: "nav.create.crm.opportunity" },
  { id: "crm.activity", consult: "crm.activity.consult", create: "crm.activity.create", update: "", titleField: "subject", nounKey: "nav.create.crm.activity" },
  { id: "crm.quote", consult: "crm.quote.consult", create: "crm.quote.create", update: "crm.quote.update", titleField: "number", nounKey: "nav.create.crm.quote" },
  { id: "sales.order", consult: "sales.order.consult", create: "sales.order.create", update: "sales.order.update", titleField: "number", nounKey: "nav.create.sales.order" },
  { id: "sales.delivery", consult: "sales.delivery.consult", create: "sales.delivery.create", update: "", titleField: "number", nounKey: "nav.create.sales.delivery" },
  { id: "sales.return", consult: "sales.return.consult", create: "sales.return.create", update: "", titleField: "number", nounKey: "nav.create.sales.return" },
  // Comisiones (plan 2B.2 Task 30.4, owner item 168): the plan is a maestro saved by its create and update (its salespeople and category
  // rates in its own form); a commission is written only by its events (accrual, reversal) and never imported.
  { id: "sales.commission_plan", consult: "sales.commission_plan.consult", create: "sales.commission_plan.create", update: "sales.commission_plan.update", titleField: "name", nounKey: "nav.create.sales.commission_plan" },
  { id: "sales.commission", consult: "sales.commission.consult", create: "", update: "", titleField: "number", nounKey: "nav.create.sales.commission", importable: false },
  // Facturación (plan 2B Task 20): an invoice is written by hand (Nueva factura, Duplicar) or from pedidos («Por facturar»), changed by its
  // update while it is a Borrador and issued with «Emitir»; a note is written only from the invoice it corrects («Crear nota crédito /
  // débito» on the invoice), so it has no create form of its own. Neither is imported: a DIAN document is issued, never loaded.
  { id: "invoicing.invoice", consult: "invoicing.invoice.consult", create: "invoicing.invoice.create", update: "invoicing.invoice.update", titleField: "number", nounKey: "nav.create.invoicing.invoice", importable: false },
  { id: "invoicing.note", consult: "invoicing.note.consult", create: "", update: "", titleField: "number", nounKey: "nav.create.invoicing.note", importable: false },
  // Pagos (plan 2B Task 24b): the medio de pago and the caja are maestros saved by their create and update processes; a recibo de caja is
  // written by «Registrar pago» (payments.payment.receive: applied, numbered and posted in one action) and never changes afterwards (Anular
  // recibo is its own step). It is not imported: money received is registered, never loaded.
  { id: "payments.method", consult: "payments.method.consult", create: "payments.method.create", update: "payments.method.update", titleField: "name", nounKey: "nav.create.payments.method" },
  { id: "payments.cash_box", consult: "payments.cash_box.consult", create: "payments.cash_box.create", update: "payments.cash_box.update", titleField: "name", nounKey: "nav.create.payments.cash_box" },
  { id: "payments.receipt", consult: "payments.receipt.consult", create: "payments.payment.receive", update: "", titleField: "number", nounKey: "nav.create.payments.receipt", importable: false },
  // Aplicar anticipo a factura (plan 2B.2 Task 36): an application is written by «Aplicar a facturas» on the receipt that holds the advance
  // (payments.advance.apply: applied, numbered and posted in one action), never edited (Deshacer aplicación is its own step) nor imported.
  { id: "payments.advance_application", consult: "payments.advance_application.consult", create: "payments.advance.apply", update: "", titleField: "number", nounKey: "nav.create.payments.advance_application", importable: false },
];

/** The id of a record not created yet: `/r/<entity>/new` opens the empty form. */
export const NEW_RECORD_ID = "new";

/** Every entity with a full record page. */
export const recordEntities = (): readonly RecordEntity[] => RECORD_ENTITIES;

/** The entity config, or null for an entity that has no full page (also for inherited object keys). */
export const recordEntity = (id: string): RecordEntity | null => RECORD_ENTITIES.find((e) => e.id === id) ?? null;
