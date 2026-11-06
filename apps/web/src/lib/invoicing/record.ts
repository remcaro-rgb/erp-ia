import "server-only";
import { getTranslations } from "next-intl/server";
import { addRefLabels, countryPack, gridPageAccess, refLabelKey, runnableProcesses, withClaims, type Caller, type FieldMode } from "@erp/kernel";
import { formatDay, formatDayTime, formatMoney, type CodeOption, type LookupSource } from "@erp/ui";
import { gridTab, type GridTab } from "@/lib/accounting/record-tabs";
import { gridEntity } from "@/lib/grid/access";
import { MASKED, moneyText } from "@/lib/records/masked";
import { buildColumns } from "@/lib/grid/columns";
import { linkableEntities } from "@/lib/grid/links";
import { receiptsOfInvoice } from "@/lib/payments/record";
import { presentationOf } from "@/lib/grid/presentation";
import { processDeps } from "@/lib/server/runtime";

// What the pages of an invoice and a note need besides the record (plan 2B Task 20, prototype 2B «Factura FE-1234»), read as the caller
// through the masked views and the grid (rule 14): the Datos tab's facts (references link to their records, rule 21), its totals in the
// money format (rule 23), the stage and the DIAN chip, the DIAN trail (Emitida · Enviada a la DIAN · Aceptada / Rechazada) with the
// DIAN's errors of a rejection, the annulment note and the notes of the invoice; the Líneas e impuestos tab's two grids (rule 20); the DIAN
// tab's submission (status, round, trackId, the errors, the files to download through signed links, rule 22); and the steps of its
// process the caller may run now. The steps are an allowlist keyed by entity (`INVOICING_STEPS`): the server action picks the process
// from the entity and the step's name, never from the client.

export type InvoicingFormKind = "invoice" | "note";

/** The invoicing entities with a full record page, and their form. */
export const INVOICING_FORMS: Readonly<Record<string, InvoicingFormKind>> = {
  "invoicing.invoice": "invoice",
  "invoicing.note": "note",
};

/**
 * The steps a stored invoice's or note's screen runs, by entity and step name: the process each runs. «Emitir» numbers, dates and posts
 * the Borrador (the documento's Grabar); «Reintentar envío» sends a rejected (or stopped) document again; «Anular (nota crédito)» issues the
 * annulment credit note (step-up); `to_note` writes a credit or debit note of the invoice and opens it.
 */
export const INVOICING_STEPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "invoicing.invoice": { issue: "invoicing.invoice.issue", resubmit: "invoicing.invoice.resubmit", void: "invoicing.invoice.void", to_note: "invoicing.note.create" },
  "invoicing.note": { issue: "invoicing.note.issue", resubmit: "invoicing.note.resubmit" },
};

export interface InvoicingFact {
  label: string;
  value: string;
  link?: { entity: string; id: string };
  /** Several records (an invoice's pedidos and entregas). */
  links?: { entity: string; id: string; label: string }[];
  mono?: boolean;
  testId?: string;
}

export type Tone = "ok" | "warn" | "danger" | "info" | "gray";

export interface DianSubmissionView {
  id: string;
  status: string;
  statusLabel: string;
  round: number;
  attempts: number;
  trackId: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  lastError: string | null;
  /** The signed XML, the DIAN's ApplicationResponse and the stored PDF, when kept (downloaded through /api/einvoice/<id>). */
  files: { file: "xml" | "response" | "pdf"; label: string }[];
}

export interface InvoicingView {
  kind: InvoicingFormKind;
  facts: InvoicingFact[];
  totals: { subtotal: string; discount: string | null; tax: string; total: string };
  stage: string;
  stageLabel: string;
  stageTone: Tone;
  /** The DIAN chip: the document's DIAN status, or its submission's while it is on its way (En cola, Sin configurar, Envío detenido). */
  dian: { label: string; tone: Tone };
  /** Emitida · Enviada a la DIAN · Aceptada (or Rechazada), each with when it happened. */
  trail: { label: string; at: string | null; done: boolean; tone: Tone }[];
  /** The DIAN's errors of the last rejection, kept while a resubmit waits for the new verdict. */
  errors: string[];
  /** The errors shown are the last rejection's and a resubmit is on its way (the new verdict has not arrived). */
  errorsPending: boolean;
  /** An invoice's annulment credit note and whether the DIAN accepted it (the invoice is then Anulada). */
  annulment: { id: string; number: string | null; accepted: boolean } | null;
  /** An invoice's notes; a note's invoice is a fact. */
  notes: { id: string; number: string; kind: string }[];
  /** The step names (`INVOICING_STEPS`) the caller may run now. */
  steps: string[];
  /** Why «Anular (nota crédito)» and the notes are not offered yet (the DIAN has not accepted the invoice…); null: they are. */
  noteBlock: string | null;
  /** The invoice's lines a note corrects (the masked view's rows) and the correction concepts of the country's tables. */
  invoiceLines: Record<string, unknown>[];
  concepts: { credit: CodeOption[]; debit: CodeOption[] };
  submission: DianSubmissionView | null;
  /** The record bar's own buttons (Task 20 fix round 1, prototype 2B): Emitir, Reintentar envío, «Anular (nota crédito)», a note's Duplicar. */
  bar: InvoicingBar;
  /** A note's concept, reason and lines as Duplicar copies them (its identity is never copied). */
  noteSource: { invoiceId: string; source: { kind: "credit" | "debit"; concept: string; reason: string; lines: Record<string, unknown>[] } } | null;
  linesGrid: GridTab | null;
  taxesGrid: GridTab | null;
}

/** A button of the bar: shown when the caller may run its process; `block` says why it is disabled now (null: it can run). */
export interface BarStep {
  block: string | null;
}

export interface InvoicingBar {
  /** The document's name (its number, else its id) for the dialogs. */
  name: string;
  issue: BarStep | null;
  resubmit: BarStep | null;
  void: BarStep | null;
  /** «Nota que se emitirá» of the Anular dialog (prototype openVoid). */
  voidPreview: { concept: string; total: string; numbering: string | null } | null;
  /** A note's Duplicar (null: not offered). */
  duplicate: BarStep | null;
}

export interface InvoicingFormData {
  kind: "invoicing";
  invoicing: InvoicingFormKind;
  today: string;
  party: LookupSource;
  product: LookupSource;
  /** The DIAN payment means the country pack accepts, named. */
  paymentMeans: CodeOption[];
  /** How the stored references read (`party_id`). */
  labels: Record<string, string>;
  /** A Borrador's lines the edit form starts from (with `product_label`). */
  lines: Record<string, unknown>[];
  /** A stored Borrador the caller may still change through invoicing.invoice.update. */
  editable: boolean;
  /** Its lines come from pedidos (they bill what shipped): the edit form does not change them. */
  linesFixed: boolean;
  lineModes: Record<string, FieldMode>;
  view: InvoicingView | null;
}

type Row = Record<string, unknown> & { id: string };

const SUBMISSION_IN_FLIGHT = new Set(["queued", "processing", "not_configured", "failed"]);
/** Where the DIAN chip reads «En proceso» (prototype 2B): the document is on its way and nothing is asked of the user. */
const SUBMISSION_WORKING = new Set(["queued", "processing", "submitted"]);
/** The catalogue key of a DIAN payment means (table 13.3.4.4: `ZZZ`, «Otro»): catalogue keys are snake_case, the code is not. */
const meansKey = (code: string) => `invoicing.values.payment_means.${code.toLowerCase()}`;
const STAGE_TONE: Record<string, Tone> = { draft: "gray", issued: "info", paid: "ok", voided: "danger" };
const DIAN_TONE: Record<string, Tone> = { draft: "gray", submitted: "warn", accepted: "ok", rejected: "danger" };
const SUBMISSION_TONE: Record<string, Tone> = { queued: "warn", processing: "warn", not_configured: "danger", failed: "danger", submitted: "warn", accepted: "ok", rejected: "danger" };

/** The fields of an entity's lookup box as the caller sees them; null when the caller may not read the entity. */
async function lookupSource(caller: Caller, entityId: string): Promise<LookupSource | null> {
  const deps = processDeps();
  const entity = gridEntity(deps.registry, entityId);
  if (!entity) return null;
  const [access, t, linkable] = await Promise.all([gridPageAccess(deps.sql, caller.claims, entity), getTranslations(), linkableEntities(deps, caller.claims, [entityId])]);
  return { fields: buildColumns(entity, access, presentationOf(entity.id), (key) => t(key)), entityLabel: t(entity.label), linkable: linkable.has(entityId) };
}

/** A DIAN error as the submission keeps it (the transport's text). */
const errorText = (e: unknown): string => (typeof e === "string" ? e : e && typeof e === "object" ? String((e as Record<string, unknown>).message ?? (e as Record<string, unknown>).description ?? JSON.stringify(e)) : String(e));

/** The Datos tab's data of an invoice or a note. */
export async function loadInvoicingForm(caller: Caller, entityId: string, record: Row | null): Promise<InvoicingFormData> {
  const deps = processDeps();
  const kind = INVOICING_FORMS[entityId]!;
  const t = await getTranslations();
  const [facts, party, product, runnable] = await Promise.all([
    withClaims(deps.sql, caller.claims, async (tx) => {
      const [company] = await tx<{ today: string; country: string }[]>`
        select (now() at time zone timezone)::date::text as today, country_code as country from kernel.companies where id = ${caller.claims.active_company_id}`;
      return { today: company?.today ?? new Date().toISOString().slice(0, 10), country: company?.country ?? "CO" };
    }),
    lookupSource(caller, "core.party"),
    lookupSource(caller, "core.product"),
    runnableProcesses(deps.sql, deps.registry, caller.claims, kind === "invoice" ? ["invoicing.invoice.update"] : []),
  ]);
  const pack = countryPack(facts.country).einvoice;
  const paymentMeans = (pack?.paymentMeans ?? []).map((code) => ({ code, name: t.has(meansKey(code)) ? t(meansKey(code)) : code }));
  const labels: Record<string, string> = {};
  if (record) {
    const header: Record<string, unknown> = { ...record };
    await withClaims(deps.sql, caller.claims, (tx) => addRefLabels(tx, deps.registry, deps.registry.entity(entityId), [header]));
    const label = header[refLabelKey("party_id")];
    if (typeof label === "string") labels.party_id = label;
  }
  const editable = record !== null && kind === "invoice" && record.stage === "draft" && record.status === "draft" && runnable.has("invoicing.invoice.update");
  let lines: Record<string, unknown>[] = [];
  let lineModes: Record<string, FieldMode> = {};
  if (record && editable) {
    const lineEntity = gridEntity(deps.registry, "invoicing.invoice_line");
    if (lineEntity) lineModes = { ...(await gridPageAccess(deps.sql, caller.claims, lineEntity)).modes };
    const stored = Array.isArray(record.lines) ? (record.lines as Record<string, unknown>[]) : [];
    const named = stored.map((l) => ({ ...l }));
    await withClaims(deps.sql, caller.claims, (tx) => addRefLabels(tx, deps.registry, deps.registry.entity("invoicing.invoice_line"), named));
    lines = named.map((l) => ({ ...l, product_label: l[refLabelKey("product_id")] ?? l.product_id }));
  }
  return {
    kind: "invoicing",
    invoicing: kind,
    today: facts.today,
    party: party ?? { fields: [], entityLabel: t("entity.core.party") },
    product: product ?? { fields: [], entityLabel: t("entity.core.product") },
    paymentMeans,
    labels,
    lines,
    editable,
    linesFixed: record !== null && record.origin !== "manual",
    lineModes,
    view: record ? await invoicingView(caller, entityId, record, facts.country) : null,
  };
}

/** The facts, totals, trail, submission, grids and steps of a stored invoice or note. */
async function invoicingView(caller: Caller, entityId: string, record: Row, country: string): Promise<InvoicingView> {
  const deps = processDeps();
  const t = await getTranslations();
  const kind = INVOICING_FORMS[entityId]!;
  const entity = deps.registry.entity(entityId);
  const steps = INVOICING_STEPS[entityId] ?? {};
  const header: Record<string, unknown> = { ...record };
  const stored = Array.isArray(record.lines) ? (record.lines as Record<string, unknown>[]) : [];
  const named = await withClaims(deps.sql, caller.claims, async (tx) => {
    await addRefLabels(tx, deps.registry, entity, [header]);
    const [company] = await tx<{ timezone: string; currency: string | null }[]>`select timezone, currency_code as currency from kernel.companies where id = ${caller.claims.active_company_id}`;
    // Its own DIAN submission (a note's submission names the invoice too: an invoice reads the one without a note).
    const [submission] =
      kind === "invoice"
        ? await tx<Record<string, unknown>[]>`select * from invoicing.v_einvoice_submissions where invoice_id = ${record.id} and note_id is null`
        : await tx<Record<string, unknown>[]>`select * from invoicing.v_einvoice_submissions where note_id = ${record.id}`;
    // An invoice's pedidos and entregas (sales' ids, named in sales' masked views as the caller, rule 3) and its notes.
    const orderIds = [...new Set(stored.map((l) => l.order_id).filter((v): v is string => typeof v === "string"))];
    const deliveryIds = [...new Set(stored.map((l) => l.delivery_id).filter((v): v is string => typeof v === "string"))];
    const orders = orderIds.length > 0 ? await tx<{ id: string; number: string | null }[]>`select id, number from sales.v_orders where id = any(${orderIds}::uuid[]) order by seq` : [];
    const deliveries = deliveryIds.length > 0 ? await tx<{ id: string; number: string | null }[]>`select id, number from sales.v_deliveries where id = any(${deliveryIds}::uuid[]) order by seq` : [];
    const notes =
      kind === "invoice"
        ? await tx<{ id: string; number: string | null; kind: string; annulment: boolean | null; dian_status: string | null }[]>`
            select id, number, kind, annulment, dian_status from invoicing.v_notes where invoice_id = ${record.id} and status <> 'voided' order by seq`
        : [];
    const [invoice] =
      kind === "note" && typeof record.invoice_id === "string"
        ? await tx<{ id: string; number: string | null }[]>`select id, number from invoicing.v_invoices where id = ${record.invoice_id}`
        : [];
    // «Numeración propia» of the Anular dialog: the credit notes' sequence as the caller sees it (masked view).
    const [creditSequence] =
      kind === "invoice"
        ? await tx<{ prefix: string | null; next_number: string | null }[]>`
            select prefix, next_number::text from core.v_document_sequences where document_type = 'credit_note' order by seq desc limit 1`
        : [];
    return { timeZone: company?.timezone, companyCurrency: company?.currency ?? null, submission: submission ?? null, orders, deliveries, notes, invoice: invoice ?? null, creditSequence: creditSequence ?? null };
  });
  const gridDef = gridEntity(deps.registry, entityId);
  const [linesGrid, taxesGrid, runnable, linkable, access] = await Promise.all([
    gridTab(caller, kind === "invoice" ? "invoicing.invoice_line" : "invoicing.note_line", [{ field: kind === "invoice" ? "invoice_id" : "note_id", op: "eq", value: record.id }]),
    gridTab(caller, kind === "invoice" ? "invoicing.invoice_tax" : "invoicing.note_tax", [{ field: kind === "invoice" ? "invoice_id" : "note_id", op: "eq", value: record.id }]),
    runnableProcesses(deps.sql, deps.registry, caller.claims, Object.values(steps)),
    linkableEntities(deps, caller.claims, ["core.party", "sales.order", "sales.delivery", "invoicing.invoice", "invoicing.note"]),
    gridDef ? gridPageAccess(deps.sql, caller.claims, gridDef) : Promise.resolve(null),
  ]);
  // Rule 14: a field the role sees masked reads as the masked marker (never «$ 0,00» or a dropped fact); a hidden one is left out.
  const modes: Record<string, FieldMode> = access?.modes ?? {};
  const currency = typeof record.currency === "string" && record.currency ? record.currency : (named.companyCurrency ?? undefined);
  const when = (raw: unknown) => (raw ? formatDayTime(raw instanceof Date ? raw.toISOString() : String(raw), named.timeZone) : null);
  const label = (field: string) => {
    const def = entity.fields.find((f) => f.name === field);
    return def && t.has(def.label) ? t(def.label) : field;
  };
  const value = (field: string): string => {
    const def = entity.fields.find((f) => f.name === field);
    const raw = record[field];
    if (modes[field] === "hidden") return "—";
    if (modes[field] === "masked") return MASKED;
    if (raw === null || raw === undefined || raw === "") return "—";
    if (def?.type === "ref") return String(header[refLabelKey(field)] ?? raw);
    if (def?.valuesKey && typeof raw === "string" && t.has(`${def.valuesKey}.${raw}`)) return t(`${def.valuesKey}.${raw}`);
    // A calendar date reads AAAA/MM/DD (owner 2026-10-31): the driver gives it as UTC midnight.
    if (def?.type === "date") return raw instanceof Date ? formatDay(raw, "UTC") : String(raw).slice(0, 10).replaceAll("-", "/");
    if (def?.type === "datetime") return when(raw) ?? "—";
    if (def?.type === "money") return formatMoney(Number(raw), currency);
    if (def?.type === "boolean") return raw === true ? t("common.yes") : t("common.no");
    return String(raw);
  };
  const plain = (field: string, extra: Partial<InvoicingFact> = {}): InvoicingFact => ({ label: label(field), value: value(field), ...extra });
  const ref = (field: string, target: string, extra: Partial<InvoicingFact> = {}): InvoicingFact => {
    const raw = record[field];
    return { label: label(field), value: value(field), ...(typeof raw === "string" && linkable.has(target) ? { link: { entity: target, id: raw } } : {}), ...extra };
  };
  const pack = countryPack(country).einvoice;
  const tv = (key: string, values?: Record<string, string | number>) => t(`invoicing.view.${key}`, values);

  const stage = String(record.stage ?? "draft");
  const stageKey = kind === "invoice" ? "invoicing.values.stage" : "invoicing.values.note_stage";
  const dianStatus = String(record.dian_status ?? "draft");
  const s = named.submission;
  const sStatus = s ? String(s.status) : null;
  const dian =
    s && sStatus && dianStatus !== "accepted" && SUBMISSION_WORKING.has(sStatus)
      ? { label: tv("dian_in_progress"), tone: "warn" as Tone }
      : s && sStatus && SUBMISSION_IN_FLIGHT.has(sStatus) && dianStatus !== "accepted"
        ? { label: t(`invoicing.values.submission_status.${sStatus}`), tone: SUBMISSION_TONE[sStatus] ?? "warn" }
        : { label: t(`invoicing.values.dian_status.${dianStatus}`), tone: DIAN_TONE[dianStatus] ?? "gray" };
  const decided = dianStatus === "accepted" || dianStatus === "rejected";
  const trail: InvoicingView["trail"] = stage === "draft" ? [] : [
    { label: tv("trail.issued"), at: when(record.issued_at), done: true, tone: "ok" },
    { label: tv("trail.submitted"), at: when(s?.submitted_at), done: !!s?.submitted_at, tone: s?.submitted_at ? "ok" : "gray" },
    { label: tv(dianStatus === "rejected" ? "trail.rejected" : "trail.accepted"), at: decided ? when(s?.decided_at) : null, done: decided, tone: dianStatus === "rejected" ? "danger" : decided ? "ok" : "gray" },
  ];
  // The last rejection's errors stay in view while the resubmit waits for the new verdict (the round keeps them until the DIAN answers).
  const kept = Array.isArray(s?.errors) ? (s!.errors as unknown[]).map(errorText) : [];
  const errorsPending = kept.length > 0 && dianStatus !== "accepted" && sStatus !== "rejected" && sStatus !== "accepted" && SUBMISSION_WORKING.has(sStatus ?? "");
  const errors = (dianStatus === "rejected" || sStatus === "rejected" || errorsPending) && sStatus !== "accepted" ? kept : [];
  const submission: DianSubmissionView | null = s
    ? {
        id: String(s.id),
        status: String(s.status),
        statusLabel: t(`invoicing.values.submission_status.${String(s.status)}`),
        round: Number(s.round ?? 1),
        attempts: Number(s.attempts ?? 0),
        trackId: typeof s.track_id === "string" ? s.track_id : null,
        submittedAt: when(s.submitted_at),
        decidedAt: when(s.decided_at),
        lastError: typeof s.last_error === "string" ? s.last_error : null,
        files: [
          ...(typeof s.xml_path === "string" && s.xml_path ? [{ file: "xml" as const, label: tv("dian_tab.xml") }] : []),
          ...(typeof s.response_path === "string" && s.response_path ? [{ file: "response" as const, label: tv("dian_tab.response") }] : []),
          ...(typeof s.pdf_path === "string" && s.pdf_path ? [{ file: "pdf" as const, label: tv("dian_tab.pdf") }] : []),
        ],
      }
    : null;

  const can: string[] = [];
  const allow = (step: string, when: boolean) => {
    const process = steps[step];
    if (when && process && runnable.has(process)) can.push(step);
  };
  const facts: InvoicingFact[] = [];
  let noteBlock: string | null = null;
  let annulment: InvoicingView["annulment"] = null;
  // A money the role does not see (masked, or null in the masked view) reads as the masked marker, never «$ 0,00».
  const money = (field: string) => moneyText(modes[field], record[field], currency);
  const resolution = record.resolution as { number?: string; prefix?: string; from?: number; to?: number } | null;

  if (kind === "invoice") {
    facts.push(ref("party_id", "core.party"));
    if (named.orders.length > 0) facts.push({ label: tv("orders"), value: named.orders.map((o) => o.number ?? o.id).join(", "), links: named.orders.map((o) => ({ entity: "sales.order", id: o.id, label: o.number ?? o.id })).filter(() => linkable.has("sales.order")), mono: true });
    if (named.deliveries.length > 0) facts.push({ label: tv("deliveries"), value: named.deliveries.map((d) => d.number ?? d.id).join(", "), links: named.deliveries.map((d) => ({ entity: "sales.delivery", id: d.id, label: d.number ?? d.id })).filter(() => linkable.has("sales.delivery")), mono: true });
    // The recibos de caja that paid it (plan 2B Task 24b), as payments publishes them (payments.v_invoice_allocations): each links to its receipt.
    const receipts = (await receiptsOfInvoice(caller, record.id)).filter((r) => r.status === "posted");
    if (receipts.length > 0) facts.push({ label: tv("receipts"), value: receipts.map((r) => r.number || r.id).join(", "), links: receipts.map((r) => ({ entity: "payments.receipt", id: r.id, label: r.number || r.id })), mono: true, testId: "invoice-receipts" });
    facts.push(plain("origin"), plain("issue_date"), plain("service_date"), plain("due_date"), plain("payment_form"));
    const means = typeof record.payment_means === "string" ? record.payment_means : null;
    if (means) facts.push({ label: label("payment_means"), value: t.has(meansKey(means)) ? tv("payment_means_value", { name: t(meansKey(means)), code: means }) : means });
    facts.push(plain("currency"));
    if (resolution?.number) facts.push({ label: tv("resolution"), value: tv("resolution_value", { number: resolution.number, prefix: resolution.prefix ?? "", from: resolution.from ?? "", to: resolution.to ?? "" }), mono: true });
    facts.push(plain("cufe", { mono: true, testId: "invoice-cufe" }), plain("issued_at"), plain("notes"));
    const annul = named.notes.find((n) => n.annulment === true);
    if (annul) annulment = { id: annul.id, number: annul.number, accepted: annul.dian_status === "accepted" || stage === "voided" };
    // Why a note (and the Anular) waits: the DIAN must have accepted the invoice (assertDianAccepted, Task 18), it is not paid, voided or annulled.
    const name = typeof record.number === "string" ? record.number : "";
    if (stage === "voided") noteBlock = tv("note_block.voided", { number: name });
    else if (annul) noteBlock = tv("note_block.annulled", { number: name });
    else if (dianStatus === "rejected") noteBlock = tv("note_block.rejected", { number: name });
    else if (dianStatus !== "accepted") noteBlock = !s ? tv("note_block.not_sent", { number: name }) : sStatus === "failed" ? tv("note_block.send_failed", { number: name }) : sStatus === "not_configured" ? tv("note_block.not_configured", { number: name }) : tv("note_block.in_progress", { number: name });
    const live = record.status !== "voided" && stage !== "voided";
    allow("issue", live && stage === "draft" && record.status === "draft");
    allow("resubmit", live && stage !== "draft" && dianStatus !== "accepted" && (!s || ["rejected", "failed", "not_configured"].includes(sStatus ?? "")));
    allow("void", live && stage === "issued" && !annul);
    allow("to_note", live && (stage === "issued" || stage === "paid") && !annul);
  } else {
    facts.push(plain("kind"));
    if (named.invoice) facts.push({ label: label("invoice_id"), value: named.invoice.number ?? named.invoice.id, mono: true, ...(linkable.has("invoicing.invoice") ? { link: { entity: "invoicing.invoice", id: named.invoice.id } } : {}) });
    facts.push(ref("party_id", "core.party"));
    const concept = typeof record.concept === "string" ? record.concept : "";
    const concepts = record.kind === "debit" ? pack?.noteConcepts.debit : pack?.noteConcepts.credit;
    const conceptName = concepts?.find((c) => c.code === concept)?.name;
    facts.push({ label: label("concept"), value: conceptName ? `${concept} · ${conceptName}` : concept || "—" });
    facts.push(plain("reason"), plain("annulment"), plain("issue_date"), plain("currency"), plain("cude", { mono: true, testId: "note-cude" }), plain("issued_at"), plain("notes"));
    allow("issue", stage === "draft" && record.status === "draft");
    allow("resubmit", stage === "issued" && dianStatus !== "accepted" && !!s && ["rejected", "failed", "not_configured"].includes(sStatus ?? ""));
  }

  // The bar's buttons (Task 20 fix round 1): each shown when the caller may run its process; disabled with why when it cannot run now.
  const may = (step: string) => {
    const process = steps[step];
    return !!process && runnable.has(process);
  };
  const docName = typeof record.number === "string" && record.number ? record.number : t(kind === "invoice" ? "invoicing.view.this_invoice" : "invoicing.view.this_note");
  const voided = stage === "voided" || record.status === "voided";
  const resubmitBlock = (): string | null => {
    if (can.includes("resubmit")) return null;
    if (stage === "draft") return tv("resubmit_block.draft");
    if (voided) return tv("resubmit_block.voided");
    if (dianStatus === "accepted") return tv("resubmit_block.accepted");
    return tv("resubmit_block.in_progress");
  };
  const paid = kind === "invoice" && (stage === "paid" || Number(record.paid_amount ?? 0) > 0);
  const voidBlock = (): string | null => (can.includes("void") && !paid && noteBlock === null ? null : paid ? tv("void_block.paid") : (noteBlock ?? tv("void_block.not_now")));
  const annulmentName = pack?.noteConcepts.credit.find((c) => c.code === pack.annulmentConcept)?.name;
  const seqNext = named.creditSequence;
  const bar: InvoicingBar = {
    name: docName,
    issue: can.includes("issue") ? { block: null } : null,
    resubmit: may("resubmit") ? { block: resubmitBlock() } : null,
    void: kind === "invoice" && may("void") && stage !== "draft" ? { block: voidBlock() } : null,
    voidPreview:
      kind === "invoice" && pack
        ? {
            concept: annulmentName ? `${pack.annulmentConcept} · ${annulmentName}` : pack.annulmentConcept,
            total: money("total"),
            numbering: seqNext && seqNext.next_number !== null ? tv("void_dialog.numbering_value", { prefix: seqNext.prefix ?? "", next: seqNext.next_number }) : null,
          }
        : null,
    duplicate: null,
  };
  let noteSource: InvoicingView["noteSource"] = null;
  if (kind === "note" && typeof record.invoice_id === "string") {
    const mayNote = (await runnableProcesses(deps.sql, deps.registry, caller.claims, ["invoicing.note.create"])).has("invoicing.note.create");
    if (mayNote) {
      bar.duplicate = { block: record.annulment === true ? tv("duplicate_block.annulment") : null };
      noteSource = {
        invoiceId: record.invoice_id,
        source: { kind: record.kind === "debit" ? "debit" : "credit", concept: typeof record.concept === "string" ? record.concept : "", reason: typeof record.reason === "string" ? record.reason : "", lines: stored.map((l) => ({ invoice_line_id: l.invoice_line_id, qty: l.qty, unit_price: l.unit_price })) },
      };
    }
  }

  const conceptOptions = (list: readonly { code: string; name: string }[] | undefined, skip?: string) => (list ?? []).filter((c) => c.code !== skip).map((c) => ({ code: c.code, name: `${c.code} · ${c.name}` }));
  return {
    kind,
    // An empty fact (no reference, not issued yet) is left out.
    facts: facts.filter((f) => f.value !== "—"),
    totals: {
      subtotal: money("subtotal"),
      discount: kind === "invoice" ? money("discount_total") : null,
      tax: money("tax_total"),
      total: money("total"),
    },
    stage,
    stageLabel: t.has(`${stageKey}.${stage}`) ? t(`${stageKey}.${stage}`) : stage,
    stageTone: STAGE_TONE[stage] ?? "gray",
    dian,
    trail,
    errors,
    errorsPending,
    annulment,
    notes: named.notes.map((n) => ({ id: n.id, number: n.number ?? n.id, kind: n.kind })),
    steps: can,
    noteBlock,
    invoiceLines: kind === "invoice" ? stored : [],
    // The annulment concept is Anular's own: a note written by hand never takes it (annulment_by_void).
    concepts: { credit: conceptOptions(pack?.noteConcepts.credit, pack?.annulmentConcept), debit: conceptOptions(pack?.noteConcepts.debit) },
    submission,
    bar,
    noteSource,
    linesGrid,
    taxesGrid,
  };
}
