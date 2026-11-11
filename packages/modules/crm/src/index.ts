import { HOME_CHARTS, HOME_KPIS } from "./home";
import { defineModule, type ModuleDef } from "@erp/kernel";
import { CRM_ENTITIES } from "./entities";
import { FEATURES, MENU_SHARED, NAVIGATION, SHORTCUTS } from "./features";
import { ACTIVITY_PROCESSES, onInvoicePaid } from "./processes/activity";
import { leadHooks, LEAD_PROCESSES } from "./processes/lead";
import { onOrderConfirmed, OPPORTUNITY_LOST, OPPORTUNITY_PROCESSES, OPPORTUNITY_STAGE_MOVED, OPPORTUNITY_WON, opportunityHooks } from "./processes/opportunity";
import { PIPELINE_PROCESSES, pipelineHooks } from "./processes/pipeline";
import { QUOTE_ACCEPTED, QUOTE_EXPIRED, QUOTE_PROCESSES, QUOTE_SENT, quoteHooks } from "./processes/quote";
import { SETTINGS_PROCESSES } from "./processes/settings";
import { quoteRecordTemplate } from "./print";

/**
 * The crm module (design §8, §8.1, plan 2B Task 11): prospectos, embudos with their etapas, oportunidades and actividades. A prospecto is
 * converted into a customer (core's create process, so the DIAN validation applies) and an oportunidad; an oportunidad moves through its
 * embudo (audited) and is won when its order is confirmed. No module is named here: it consumes `sales.order.confirmed` and
 * `invoicing.invoice.paid` by event name, which the sales and invoicing modules emit once they are loaded (the kernel registers a consumer
 * for any event name; until an emitter exists the consumers simply never run). The oportunidad reference is `opportunityId` in both payloads
 * (see processes/opportunity.ts).
 *
 * Cotizaciones (Task 12, design §8: quotes are crm's) are priced by the sales module's price resolution (`resolveLinePrice`) and pass its
 * invoice-readiness gate, so crm depends on sales; accepting one emits crm.quote.accepted (with `opportunityId` when it came from a deal),
 * which the sales order (Task 13) starts from.
 */
export const crm: ModuleDef = defineModule({
  id: "crm",
  version: "0.1.0",
  dependsOn: ["core", "sales"],
  icon: "network",
  entities: CRM_ENTITIES,
  processes: [...LEAD_PROCESSES, ...PIPELINE_PROCESSES, ...OPPORTUNITY_PROCESSES, ...ACTIVITY_PROCESSES, ...QUOTE_PROCESSES, ...SETTINGS_PROCESSES],
  features: FEATURES,
  // Its Inicio cards (plan 2B Task 26).
  homeKpis: HOME_KPIS,
  homeCharts: HOME_CHARTS,
  events: {
    emits: [OPPORTUNITY_STAGE_MOVED, OPPORTUNITY_WON, OPPORTUNITY_LOST, QUOTE_SENT, QUOTE_ACCEPTED, QUOTE_EXPIRED],
    consumes: { "sales.order.confirmed": onOrderConfirmed, "invoicing.invoice.paid": onInvoicePaid },
  },
  navigation: NAVIGATION,
  shortcuts: SHORTCUTS,
  menuShared: MENU_SHARED,
  // What the assistant's confirmation card tells about the deals (plan 2B Task 25): what this module's consumers do.
  effects: {
    "sales.order.confirmed": ["crm.effects.order_won"],
    "invoicing.invoice.paid": ["crm.effects.invoice_paid"],
  },
  // The lifecycle of the maestros, the oportunidad and the cotización (entity types spec §5): Grabar runs the checks; an oportunidad numbers
  // OP- on save, a cotización COT-.
  typedHooks: {
    "crm.lead": leadHooks,
    "crm.pipeline": pipelineHooks,
    "crm.opportunity": opportunityHooks,
    "crm.quote": quoteHooks,
  },
  // Imprimir: the cotización's own default template (its commercial fields and lines) when the company chose none.
  printTemplates: { "crm.quote": { record: quoteRecordTemplate } },
});

export { CRM_ENTITIES, ACTIVITY_KINDS, LEAD_SOURCES, LEAD_STAGES, OUTCOMES, QUOTE_STAGES, STAGE_KINDS } from "./entities";
export type { ActivityKind, Outcome, QuoteStage, StageKind } from "./entities";
export { QUOTE_ACCEPTED, QUOTE_EXPIRED, QUOTE_SENT } from "./processes/quote";
export { OPPORTUNITY_LOST, OPPORTUNITY_STAGE_MOVED, OPPORTUNITY_WON, onOrderConfirmed } from "./processes/opportunity";
export { onInvoicePaid } from "./processes/activity";
export { STANDARD_STAGES } from "./processes/pipeline";
