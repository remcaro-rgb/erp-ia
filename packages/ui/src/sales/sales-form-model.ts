// The Datos tab of the CRM and sales records (plan 2B Task 14b): the prospecto and the embudo (maestros), the oportunidad, the cotización
// and the pedido (documentos with priced lines), the entrega and the devolución (documentos that deliver or take back the lines of
// another one) and the actividad. Pure, so the rules (what each create or update process takes, what a draft still misses) are
// unit-tested; the forms only draw them. Prices, discounts and taxes are the processes' (sales' price resolution and the country pack):
// a line sends a price or a discount only when the user typed one.

import { parseQty } from "../inventory/stock-form-model";
import { parseMoney } from "../money/format";

/** An amount as typed (`$ 1.234.567,00`, `1500000`); NaN when it is not one. */
const parseAmount = (text: string): number => parseMoney(text) ?? Number.NaN;

/** The forms of the CRM and sales records. */
export type SalesFormKind = "lead" | "pipeline" | "opportunity" | "quote" | "order" | "delivery" | "return" | "activity";

type Row = Readonly<Record<string, unknown>>;
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
/** A calendar date as the date box wants it (yyyy-mm-dd); the driver may give a Date at UTC midnight. */
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : s(v).slice(0, 10));
/** A number as the box shows it (no trailing zeros of numeric(18,4)). */
const numText = (v: unknown) => (v === null || v === undefined || v === "" ? "" : String(Number(v)));
const trimmed = (v: string) => (v.trim() ? v.trim() : undefined);
const definedOnly = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

let lineSeq = 0;
const nextKey = () => `s${++lineSeq}`;

// ---------------------------------------------------------------------------------------------------------------------------------
// Cotización and pedido: a customer and priced lines.

export interface SaleLine {
  key: string;
  productId: string;
  productLabel: string;
  /** As typed. */
  qty: string;
  /** Empty: the price list (or the product's list price) gives it. */
  unitPrice: string;
  /** Empty: the customer's standing discount. */
  discountPct: string;
  description: string;
}

export interface SaleDraft {
  partyId: string;
  partyLabel: string;
  opportunityId: string;
  opportunityLabel: string;
  issueDate: string;
  validUntil: string;
  deliveryDate: string;
  warehouseId: string;
  /** An invoice (plan 2B Task 20): 1 contado, 2 crédito; empty, the process's default (crédito with the company's days). */
  paymentForm: string;
  /** An invoice: the DIAN payment means code; empty, the process's default. */
  paymentMeans: string;
  /** An invoice: the due date; empty, the process computes it from the payment form. */
  dueDate: string;
  /** The document's currency (ISO 4217); empty, the company's. Chosen on a new document only (Task 34.3). */
  currency: string;
  /** A foreign-currency document's rate as typed (company currency per unit); empty on a new one, Tasas de cambio's of the date. */
  exchangeRate: string;
  notes: string;
  lines: SaleLine[];
}

export const emptySaleLine = (): SaleLine => ({ key: nextKey(), productId: "", productLabel: "", qty: "", unitPrice: "", discountPct: "", description: "" });

/**
 * A cotización's or pedido's draft: the stored record and its lines (an open one is edited), a copy's header ("Duplicar"), or today and
 * one empty line. `labels` names the references by field (`party_id` → the customer's name).
 */
export function saleDraft(today: string, record: Row | null, lines: readonly Row[] = [], labels: Readonly<Record<string, string>> = {}): SaleDraft {
  const stored = lines.map((l) => ({
    key: nextKey(),
    productId: s(l.product_id),
    productLabel: s(l.product_label ?? l.product_id),
    qty: numText(l.qty),
    unitPrice: numText(l.unit_price),
    discountPct: Number(l.discount_pct ?? 0) === 0 ? "" : numText(l.discount_pct),
    description: s(l.description),
  }));
  return {
    partyId: s(record?.party_id),
    partyLabel: labels.party_id ?? s(record?.party_id),
    opportunityId: s(record?.opportunity_id),
    opportunityLabel: labels.opportunity_id ?? s(record?.opportunity_id),
    issueDate: day(record?.issue_date) || today,
    validUntil: day(record?.valid_until),
    deliveryDate: day(record?.delivery_date),
    warehouseId: s(record?.warehouse_id),
    paymentForm: s(record?.payment_form),
    paymentMeans: s(record?.payment_means),
    dueDate: day(record?.due_date),
    currency: s(record?.currency).trim(),
    exchangeRate: numText(record?.exchange_rate),
    notes: s(record?.notes),
    lines: [...stored, emptySaleLine()],
  };
}

/** The lines the user filled (a product chosen); an empty trailing line is not sent. */
export const filledSaleLines = (draft: SaleDraft): SaleLine[] => draft.lines.filter((l) => l.productId !== "");

/** What the draft still misses before it can be sent: i18n keys under `sales.form.missing_field` (empty when it is complete). */
export function saleMissing(draft: SaleDraft): string[] {
  const missing: string[] = [];
  if (draft.partyId === "") missing.push("party");
  const lines = filledSaleLines(draft);
  if (lines.length === 0) missing.push("lines");
  if (lines.some((l) => !(parseQty(l.qty) > 0))) missing.push("qty");
  if (lines.some((l) => l.unitPrice.trim() !== "" && !(parseAmount(l.unitPrice) >= 0))) missing.push("price");
  if (lines.some((l) => l.discountPct.trim() !== "" && !(parseQty(l.discountPct) >= 0 && parseQty(l.discountPct) <= 100))) missing.push("discount");
  if (draft.exchangeRate.trim() !== "" && !(parseAmount(draft.exchangeRate) > 0)) missing.push("rate");
  return missing;
}

/** The rate typed, as a number; undefined when the box is empty (a new document then takes Tasas de cambio's rate of its date). */
const rateOf = (draft: SaleDraft): number | undefined => (draft.exchangeRate.trim() ? parseAmount(draft.exchangeRate) : undefined);

const lineInput = (l: SaleLine) =>
  definedOnly({
    productId: l.productId,
    qty: parseQty(l.qty),
    unitPrice: l.unitPrice.trim() ? parseAmount(l.unitPrice) : undefined,
    discountPct: l.discountPct.trim() ? parseQty(l.discountPct) : undefined,
    description: trimmed(l.description),
  });

/**
 * How an update compares with what the caller was shown (rule 14): `initial` is the draft the stored record gave; `masked` the columns the
 * caller sees masked or hidden (their value never reached the form). An update then sends only the header fields that changed and are not
 * masked, and the lines only when they changed: sending a masked or untouched field would write the masked value (or clear it).
 */
export interface SaleUpdateBasis {
  initial?: SaleDraft;
  masked?: ReadonlySet<string>;
  /** An invoice of pedidos (plan 2B Task 20): its lines bill what shipped, so an update never sends them. */
  linesLocked?: boolean;
}

/** The documents with a customer and priced lines: cotización, pedido and (plan 2B Task 20) factura. */
export type SaleDocumentKind = "quote" | "order" | "invoice";

/**
 * The input of crm.quote.create / update, sales.order.create / update or invoicing.invoice.create / update (`id` given: the update of a
 * stored, open one; an invoice's while it is a Borrador).
 */
export function saleInput(kind: SaleDocumentKind, draft: SaleDraft, id: string | null, basis: SaleUpdateBasis = {}): Record<string, unknown> {
  const lines = filledSaleLines(draft).map(lineInput);
  const notes = draft.notes.trim() ? draft.notes.trim() : null;
  if (id) {
    const { initial, masked = new Set<string>() } = basis;
    const header: [column: string, key: keyof SaleDraft, value: unknown][] =
      kind === "quote"
        ? [["valid_until", "validUntil", draft.validUntil || undefined], ["notes", "notes", notes]]
        : kind === "invoice"
          ? [["issue_date", "issueDate", draft.issueDate || undefined], ["due_date", "dueDate", draft.dueDate || undefined], ["payment_form", "paymentForm", draft.paymentForm || undefined], ["payment_means", "paymentMeans", draft.paymentMeans || undefined], ["notes", "notes", notes]]
          : [["delivery_date", "deliveryDate", draft.deliveryDate || null], ["warehouse_id", "warehouseId", draft.warehouseId || null], ["notes", "notes", notes]];
    header.push(["exchange_rate", "exchangeRate", rateOf(draft)]);
    const out: Record<string, unknown> = { id };
    const linesChanged = !initial || JSON.stringify(lines) !== JSON.stringify(filledSaleLines(initial).map(lineInput));
    if (linesChanged && !basis.linesLocked) out.lines = lines;
    for (const [column, key, value] of header) {
      if (masked.has(column)) continue;
      if (initial && draft[key] === initial[key]) continue;
      out[key] = value;
    }
    return definedOnly(out);
  }
  const common = definedOnly({ partyId: draft.partyId, issueDate: draft.issueDate || undefined, currency: draft.currency || undefined, exchangeRate: rateOf(draft), notes: trimmed(draft.notes), lines });
  if (kind === "quote") return { ...common, ...definedOnly({ opportunityId: draft.opportunityId || undefined, validUntil: draft.validUntil || undefined }) };
  if (kind === "invoice") return { ...common, ...definedOnly({ dueDate: draft.dueDate || undefined, paymentForm: draft.paymentForm || undefined, paymentMeans: draft.paymentMeans || undefined }) };
  return { ...common, ...definedOnly({ deliveryDate: draft.deliveryDate || undefined, warehouseId: draft.warehouseId || undefined }) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Entrega and devolución: the lines of a pedido (or an entrega) and how much of each goes.

export interface FulfilLine {
  /** The pedido line (entrega) or entrega line (devolución) it takes from. */
  lineId: string;
  lineNo: number;
  label: string;
  /** What the source line holds (ordered or delivered). */
  sourceQty: number;
  /** As typed; empty: the line is not sent, and with no line typed at all the process takes everything left. */
  qty: string;
}

export interface FulfilDraft {
  sourceId: string;
  sourceLabel: string;
  date: string;
  warehouseId: string;
  reason: string;
  notes: string;
  lines: FulfilLine[];
}

export const fulfilDraft = (today: string, copy: Row | null = null): FulfilDraft => ({
  sourceId: "",
  sourceLabel: "",
  date: today,
  warehouseId: s(copy?.warehouse_id),
  reason: s(copy?.reason),
  notes: s(copy?.notes),
  lines: [],
});

export function fulfilMissing(kind: "delivery" | "return", draft: FulfilDraft): string[] {
  const missing: string[] = [];
  if (draft.sourceId === "") missing.push(kind === "delivery" ? "order" : "delivery");
  if (kind === "return" && draft.reason.trim().length === 0) missing.push("reason");
  if (draft.lines.some((l) => l.qty.trim() !== "" && !(parseQty(l.qty) > 0 && parseQty(l.qty) <= l.sourceQty))) missing.push("qty");
  return missing;
}

/** The input of sales.delivery.create or sales.return.create: only the lines with a quantity typed (none: everything left). */
export function fulfilInput(kind: "delivery" | "return", draft: FulfilDraft): Record<string, unknown> {
  const typed = draft.lines.filter((l) => l.qty.trim() !== "");
  const lines = typed.length === 0 ? undefined : typed.map((l) => (kind === "delivery" ? { orderLineId: l.lineId, qty: parseQty(l.qty) } : { deliveryLineId: l.lineId, qty: parseQty(l.qty) }));
  const common = definedOnly({ date: draft.date || undefined, notes: trimmed(draft.notes), lines });
  if (kind === "delivery") return { orderId: draft.sourceId, ...common, ...definedOnly({ warehouseId: draft.warehouseId || undefined }) };
  return { deliveryId: draft.sourceId, reason: draft.reason.trim(), ...common };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Prospecto.

export const MANUAL_LEAD_STAGES = ["new", "contacted", "qualified", "discarded"] as const;
export const LEAD_SOURCE_OPTIONS = ["web", "referral", "event", "call", "social", "other"] as const;

export interface LeadDraft {
  name: string;
  contactName: string;
  email: string;
  phoneCc: string;
  phone: string;
  personType: string;
  documentType: string;
  documentNumber: string;
  source: string;
  stage: string;
  notes: string;
  isActive: boolean;
}

export const leadDraft = (record: Row | null): LeadDraft => ({
  name: s(record?.name),
  contactName: s(record?.contact_name),
  email: s(record?.email),
  phoneCc: s(record?.phone_cc),
  phone: s(record?.phone),
  personType: s(record?.person_type),
  documentType: s(record?.document_type),
  documentNumber: s(record?.document_number),
  source: s(record?.source) || "other",
  stage: s(record?.stage) || "new",
  notes: s(record?.notes),
  isActive: record ? record.is_active !== false : true,
});

export const leadMissing = (draft: LeadDraft): string[] => {
  const missing: string[] = [];
  if (draft.name.trim() === "") missing.push("name");
  if ((draft.phone.trim() === "") !== (draft.phoneCc.trim() === "")) missing.push("phone");
  return missing;
};

/** crm.lead.create (no id) or crm.lead.update. A converted prospecto keeps its stage (the process owns `converted`). */
export function leadInput(draft: LeadDraft, id: string | null): Record<string, unknown> {
  return definedOnly({
    ...(id ? { id } : {}),
    name: draft.name.trim(),
    contactName: trimmed(draft.contactName),
    email: trimmed(draft.email),
    phoneCc: trimmed(draft.phoneCc),
    phone: trimmed(draft.phone),
    personType: draft.personType || undefined,
    documentType: trimmed(draft.documentType),
    documentNumber: trimmed(draft.documentNumber),
    source: draft.source,
    stage: id && (MANUAL_LEAD_STAGES as readonly string[]).includes(draft.stage) ? draft.stage : undefined,
    notes: trimmed(draft.notes),
    isActive: draft.isActive,
  });
}

/** What crm.lead.convert takes from its panel: the document data the prospecto may still lack and the oportunidad. */
export interface ConvertDraft {
  personType: string;
  documentType: string;
  documentNumber: string;
  firstName: string;
  firstSurname: string;
  opportunityTitle: string;
  amount: string;
  expectedClose: string;
}

export const convertDraft = (lead: Row): ConvertDraft => ({
  personType: s(lead.person_type),
  documentType: s(lead.document_type),
  documentNumber: s(lead.document_number),
  firstName: "",
  firstSurname: "",
  opportunityTitle: s(lead.name),
  amount: "",
  expectedClose: "",
});

export function convertInput(id: string, draft: ConvertDraft): Record<string, unknown> {
  return definedOnly({
    id,
    personType: draft.personType || undefined,
    documentType: trimmed(draft.documentType),
    documentNumber: trimmed(draft.documentNumber),
    // A natural person (2) carries their names into the tercero.
    firstName: draft.personType === "2" ? trimmed(draft.firstName) : undefined,
    firstSurname: draft.personType === "2" ? trimmed(draft.firstSurname) : undefined,
    opportunityTitle: trimmed(draft.opportunityTitle),
    amount: draft.amount.trim() ? parseAmount(draft.amount) : undefined,
    expectedClose: draft.expectedClose || undefined,
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Embudo: its etapas in order.

export const STAGE_KIND_OPTIONS = ["open", "won", "lost"] as const;

export interface StageDraft {
  key: string;
  /** A stored etapa (kept with its deals); empty for a new one. */
  id: string;
  name: string;
  probability: string;
  kind: string;
}

export interface PipelineDraft {
  code: string;
  name: string;
  description: string;
  isDefault: boolean;
  isActive: boolean;
  stages: StageDraft[];
}

/** The standard etapas a new embudo starts with (crm's STANDARD_STAGES). */
const STANDARD = [
  { name: "Nuevo", probability: "10", kind: "open" },
  { name: "Calificado", probability: "30", kind: "open" },
  { name: "Propuesta", probability: "60", kind: "open" },
  { name: "Negociación", probability: "80", kind: "open" },
  { name: "Ganada", probability: "100", kind: "won" },
  { name: "Perdida", probability: "0", kind: "lost" },
];

export function pipelineDraft(record: Row | null, stages: readonly Row[] = []): PipelineDraft {
  const rows = record && stages.length > 0
    ? [...stages].sort((a, b) => Number(a.line_no) - Number(b.line_no)).map((st) => ({ key: nextKey(), id: s(st.id), name: s(st.name), probability: numText(st.probability), kind: s(st.kind) || "open" }))
    : STANDARD.map((st) => ({ key: nextKey(), id: "", ...st }));
  return {
    code: s(record?.code),
    name: s(record?.name),
    description: s(record?.description),
    isDefault: record?.is_default === true,
    isActive: record ? record.is_active !== false : true,
    stages: rows,
  };
}

export const emptyStage = (): StageDraft => ({ key: nextKey(), id: "", name: "", probability: "0", kind: "open" });

export function pipelineMissing(draft: PipelineDraft): string[] {
  const missing: string[] = [];
  if (draft.code.trim() === "") missing.push("code");
  if (draft.name.trim() === "") missing.push("name");
  const stages = draft.stages.filter((st) => st.name.trim() !== "");
  if (stages.length < 3 || !stages.some((st) => st.kind === "won") || !stages.some((st) => st.kind === "lost")) missing.push("stages");
  return missing;
}

/** crm.pipeline.create (the etapas without ids) or crm.pipeline.update (the kept etapas name their ids). */
export function pipelineInput(draft: PipelineDraft, id: string | null): Record<string, unknown> {
  const stages = draft.stages
    .filter((st) => st.name.trim() !== "")
    .map((st) => ({ ...(id && st.id ? { id: st.id } : {}), name: st.name.trim(), probability: Number.isFinite(parseQty(st.probability)) ? parseQty(st.probability) : 0, kind: st.kind }));
  return definedOnly({
    ...(id ? { id } : {}),
    code: draft.code.trim(),
    name: draft.name.trim(),
    description: trimmed(draft.description),
    // The default embudo is changed from the record of the one that becomes it; create may name it.
    isDefault: id ? undefined : draft.isDefault,
    isActive: draft.isActive,
    stages,
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Oportunidad: a deal with a customer (or a prospecto), and what it is about.

export interface OpportunityLine {
  key: string;
  productId: string;
  productLabel: string;
  description: string;
  qty: string;
  unitPrice: string;
}

export interface OpportunityDraft {
  title: string;
  partyId: string;
  partyLabel: string;
  leadId: string;
  leadLabel: string;
  pipelineId: string;
  amount: string;
  expectedClose: string;
  description: string;
  lines: OpportunityLine[];
}

export const emptyOpportunityLine = (): OpportunityLine => ({ key: nextKey(), productId: "", productLabel: "", description: "", qty: "", unitPrice: "" });

export const opportunityDraft = (copy: Row | null = null, labels: Readonly<Record<string, string>> = {}): OpportunityDraft => ({
  title: s(copy?.title),
  partyId: s(copy?.party_id),
  partyLabel: labels.party_id ?? s(copy?.party_id),
  leadId: s(copy?.lead_id),
  leadLabel: labels.lead_id ?? s(copy?.lead_id),
  pipelineId: s(copy?.pipeline_id),
  amount: numText(copy?.amount),
  expectedClose: day(copy?.expected_close),
  description: s(copy?.description),
  lines: [emptyOpportunityLine()],
});

const filledOpportunityLines = (draft: OpportunityDraft) => draft.lines.filter((l) => l.productId !== "" || l.description.trim() !== "");

export function opportunityMissing(draft: OpportunityDraft): string[] {
  const missing: string[] = [];
  if (draft.title.trim() === "") missing.push("title");
  if (draft.partyId === "" && draft.leadId === "") missing.push("party_or_lead");
  if (draft.amount.trim() !== "" && !(parseAmount(draft.amount) >= 0)) missing.push("amount");
  if (filledOpportunityLines(draft).some((l) => !(parseQty(l.qty) > 0) || (l.unitPrice.trim() !== "" && !(parseAmount(l.unitPrice) >= 0)))) missing.push("qty");
  return missing;
}

export function opportunityInput(draft: OpportunityDraft): Record<string, unknown> {
  return definedOnly({
    title: draft.title.trim(),
    partyId: draft.partyId || undefined,
    leadId: draft.leadId || undefined,
    pipelineId: draft.pipelineId || undefined,
    amount: draft.amount.trim() ? parseAmount(draft.amount) : undefined,
    expectedClose: draft.expectedClose || undefined,
    description: trimmed(draft.description),
    lines: filledOpportunityLines(draft).map((l) =>
      definedOnly({ productId: l.productId || undefined, description: trimmed(l.description), qty: parseQty(l.qty), unitPrice: l.unitPrice.trim() ? parseAmount(l.unitPrice) : undefined }),
    ),
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Actividad: a call, a meeting, an e-mail, a note or a task of an oportunidad, a prospecto or a tercero. `payment` is the system's.

export const ACTIVITY_KIND_OPTIONS = ["call", "meeting", "email", "note", "task"] as const;

export interface ActivityDraft {
  kind: string;
  subject: string;
  notes: string;
  opportunityId: string;
  opportunityLabel: string;
  leadId: string;
  leadLabel: string;
  partyId: string;
  partyLabel: string;
  /** yyyy-mm-dd; the task is due at the end of that day in the company's zone (the server's offset is not known here: noon UTC). */
  dueDate: string;
  done: boolean;
}

export const activityDraft = (copy: Row | null = null, labels: Readonly<Record<string, string>> = {}): ActivityDraft => ({
  kind: (ACTIVITY_KIND_OPTIONS as readonly string[]).includes(s(copy?.kind)) ? s(copy?.kind) : "call",
  subject: s(copy?.subject),
  notes: s(copy?.notes),
  opportunityId: s(copy?.opportunity_id),
  opportunityLabel: labels.opportunity_id ?? s(copy?.opportunity_id),
  leadId: s(copy?.lead_id),
  leadLabel: labels.lead_id ?? s(copy?.lead_id),
  partyId: s(copy?.party_id),
  partyLabel: labels.party_id ?? s(copy?.party_id),
  dueDate: "",
  done: false,
});

export function activityMissing(draft: ActivityDraft): string[] {
  const missing: string[] = [];
  if (draft.subject.trim() === "") missing.push("subject");
  if (!draft.opportunityId && !draft.leadId && !draft.partyId) missing.push("about");
  return missing;
}

export function activityInput(draft: ActivityDraft): Record<string, unknown> {
  return definedOnly({
    kind: draft.kind,
    subject: draft.subject.trim(),
    notes: trimmed(draft.notes),
    opportunityId: draft.opportunityId || undefined,
    leadId: draft.leadId || undefined,
    partyId: draft.partyId || undefined,
    dueAt: draft.dueDate ? `${draft.dueDate}T12:00:00Z` : undefined,
    done: draft.done,
  });
}
