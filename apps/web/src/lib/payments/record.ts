import "server-only";
import { getTranslations } from "next-intl/server";
import { addRefLabels, countryPack, GridState, gridPageAccess, refLabelKey, runGridQuery, runnableProcesses, withClaims, type Caller, type FieldMode, type GridStateInput } from "@erp/kernel";
import { formatDay, formatDayTime, type CodeOption, type LookupSource, type MethodOption } from "@erp/ui";
import { gridTab, type GridTab } from "@/lib/accounting/record-tabs";
import { gridDenial, gridEntity } from "@/lib/grid/access";
import { buildColumns } from "@/lib/grid/columns";
import { linkableEntities } from "@/lib/grid/links";
import { presentationOf } from "@/lib/grid/presentation";
import { MASKED, moneyText } from "@/lib/records/masked";
import { processDeps } from "@/lib/server/runtime";

// What the pages of the payments records need besides the record (plan 2B Task 24b, prototype 2B «Recibo de caja RC-0088»), read as the
// caller through the masked views and the grid (rule 14): a medio de pago's DIAN codes (the country pack's table 13.3.4.2); «Registrar
// pago»'s medios de pago and cajas (usable ones, masked views through the grid), the customer box's fields and whether invoices link
// (rule 21); and for a stored receipt its facts (references link to their records), its money in the money format (rule 23, masked reads
// masked), its state chip, what it applied to each invoice with the withholdings (Asignaciones: the universal grid, rule 20, and the
// certificate lines) and «Anular recibo» when the caller may run it. The steps are an allowlist keyed by entity (`PAYMENTS_STEPS`): the
// server action picks the process from the entity and the step's name, never from the client.

export type PaymentsFormKind = "method" | "cash_box" | "receipt";

/** The payments entities with a full record page, and their form. */
export const PAYMENTS_FORMS: Readonly<Record<string, PaymentsFormKind>> = {
  "payments.method": "method",
  "payments.cash_box": "cash_box",
  "payments.receipt": "receipt",
};

/** The steps a stored receipt's screen runs, by entity and step name: «Anular recibo» (step-up) reverses its entry. */
export const PAYMENTS_STEPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "payments.receipt": { void: "payments.payment.void" },
};

export type Tone = "ok" | "warn" | "danger" | "info" | "gray";

export interface PaymentsFact {
  label: string;
  value: string;
  link?: { entity: string; id: string };
  mono?: boolean;
  testId?: string;
}

export interface AllocationView {
  invoiceId: string;
  invoiceNumber: string;
  /** The invoice opens from here (rule 21). */
  linkable: boolean;
  amount: string;
  cash: string;
  withholdingTotal: string;
  withholdings: { kind: string; code: string; rate: string; base: string; amount: string }[];
}

export interface ReceiptView {
  facts: PaymentsFact[];
  status: string;
  statusLabel: string;
  statusTone: Tone;
  totals: { amount: string; applied: string; withholdings: string; advance: string };
  /** What the posting did, as the prototype's note says it (the withholdings are a tax in favour; an advance is owed to the customer). */
  notes: { tone: Tone; key: "withholdings" | "settled" | "advance" | "no_advance" | "voided"; values: Record<string, string> }[];
  allocations: AllocationView[];
  allocationsGrid: GridTab | null;
  /** «Anular recibo» (null: the caller may not run it, or the receipt is not posted). */
  void: { name: string; invoices: { number: string; amount: string }[] } | null;
}

export interface PaymentsFormData {
  kind: "payments";
  payments: PaymentsFormKind;
  today: string;
  /** A medio de pago's «Código DIAN» options. */
  meansCodes: CodeOption[];
  /** «Registrar pago»: the usable medios de pago and cajas. */
  methods: MethodOption[];
  cashBoxes: CodeOption[];
  party: LookupSource;
  invoicesLinkable: boolean;
  view: ReceiptView | null;
}

type Row = Record<string, unknown> & { id: string };

const STATUS_TONE: Record<string, Tone> = { posted: "ok", voided: "danger" };

/** Rows of an entity through the grid query, as the caller (its gate, RLS and masks); none when the caller may not read it. */
async function gridRows(caller: Caller, entityId: string, state: GridStateInput) {
  const deps = processDeps();
  const entity = gridEntity(deps.registry, entityId);
  if (!entity || (await gridDenial(deps, caller.claims, entity))) return { rows: [] as Record<string, unknown>[], total: 0 };
  return runGridQuery(deps.sql, caller.claims, entity, GridState.parse(state));
}

/** The fields of an entity's lookup box as the caller sees them; null when the caller may not read the entity. */
async function lookupSource(caller: Caller, entityId: string): Promise<LookupSource | null> {
  const deps = processDeps();
  const entity = gridEntity(deps.registry, entityId);
  if (!entity) return null;
  const [access, t, linkable] = await Promise.all([gridPageAccess(deps.sql, caller.claims, entity), getTranslations(), linkableEntities(deps, caller.claims, [entityId])]);
  return { fields: buildColumns(entity, access, presentationOf(entity.id), (key) => t(key)), entityLabel: t(entity.label), linkable: linkable.has(entityId) };
}

/** The Datos tab's data of a medio de pago, a caja or a recibo de caja. */
export async function loadPaymentsForm(caller: Caller, entityId: string, record: Row | null): Promise<PaymentsFormData> {
  const deps = processDeps();
  const kind = PAYMENTS_FORMS[entityId]!;
  const t = await getTranslations();
  const company = await withClaims(deps.sql, caller.claims, async (tx) => {
    const [row] = await tx<{ today: string; country: string }[]>`
      select (now() at time zone timezone)::date::text as today, country_code as country from kernel.companies where id = ${caller.claims.active_company_id}`;
    return { today: row?.today ?? new Date().toISOString().slice(0, 10), country: row?.country ?? "CO" };
  });
  const base: PaymentsFormData = { kind: "payments", payments: kind, today: company.today, meansCodes: [], methods: [], cashBoxes: [], party: { fields: [], entityLabel: t("entity.core.party") }, invoicesLinkable: false, view: null };
  if (kind === "method") {
    const means = countryPack(company.country).einvoice?.paymentMeans ?? [];
    const key = (code: string) => `invoicing.values.payment_means.${code.toLowerCase()}`;
    return { ...base, meansCodes: means.map((code) => ({ code, name: t.has(key(code)) ? t(key(code)) : code })) };
  }
  if (kind === "cash_box") return base;
  if (record) return { ...base, view: await receiptView(caller, record) };
  // «Registrar pago»: the medios de pago and cajas a receipt may name (active ones, as the caller sees them in their grids).
  const active = [{ field: "is_active", op: "eq" as const, value: true }];
  const [methods, boxes, party, linkable] = await Promise.all([
    gridRows(caller, "payments.method", { filters: active, sort: [{ field: "name", dir: "asc" }], page: 1, pageSize: 200, columns: ["name", "kind", "code", "status"] }),
    gridRows(caller, "payments.cash_box", { filters: active, sort: [{ field: "code", dir: "asc" }], page: 1, pageSize: 200, columns: ["code", "name", "status"] }),
    lookupSource(caller, "core.party"),
    linkableEntities(deps, caller.claims, ["invoicing.invoice"]),
  ]);
  // A maestro waiting for approval (or not approved) is not usable in a document (the lifecycle's gate): it is not offered.
  const usable = (r: Record<string, unknown>) => !["draft", "pending", "rejected"].includes(String(r.status ?? ""));
  return {
    ...base,
    methods: methods.rows.filter(usable).map((m) => ({ id: String(m.id), name: String(m.name ?? m.code ?? m.id), kind: String(m.kind ?? "other") })),
    cashBoxes: boxes.rows.filter(usable).map((b) => ({ code: String(b.id), name: `${String(b.code ?? "")} · ${String(b.name ?? "")}` })),
    party: party ?? base.party,
    invoicesLinkable: linkable.has("invoicing.invoice"),
  };
}

/** The facts, totals, allocations, grid and «Anular recibo» of a stored receipt. */
async function receiptView(caller: Caller, record: Row): Promise<ReceiptView> {
  const deps = processDeps();
  const t = await getTranslations();
  const entity = deps.registry.entity("payments.receipt");
  const header: Record<string, unknown> = { ...record };
  const { timeZone } = await withClaims(deps.sql, caller.claims, async (tx) => {
    await addRefLabels(tx, deps.registry, entity, [header]);
    const [company] = await tx<{ timezone: string }[]>`select timezone from kernel.companies where id = ${caller.claims.active_company_id}`;
    return { timeZone: company?.timezone };
  });
  const gridDef = gridEntity(deps.registry, entity.id);
  const lineDef = gridEntity(deps.registry, "payments.receipt_allocation");
  const [allocationsGrid, runnable, linkable, access, lineAccess] = await Promise.all([
    gridTab(caller, "payments.receipt_allocation", [{ field: "receipt_id", op: "eq", value: record.id }]),
    runnableProcesses(deps.sql, deps.registry, caller.claims, Object.values(PAYMENTS_STEPS["payments.receipt"]!)),
    linkableEntities(deps, caller.claims, ["core.party", "payments.method", "payments.cash_box", "invoicing.invoice"]),
    gridDef ? gridPageAccess(deps.sql, caller.claims, gridDef) : Promise.resolve(null),
    lineDef ? gridPageAccess(deps.sql, caller.claims, lineDef) : Promise.resolve(null),
  ]);
  // Rule 14: a field the role sees masked reads as the masked marker (never «$ 0,00»); a hidden one is left out.
  const modes: Record<string, FieldMode> = access?.modes ?? {};
  const lineModes: Record<string, FieldMode> = lineAccess?.modes ?? {};
  const currency = typeof record.currency === "string" && record.currency ? record.currency : undefined;
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
    // A calendar date reads AAAA/MM/DD (owner 2026-10-31): the driver gives it as UTC midnight.
    if (def?.type === "date") return raw instanceof Date ? formatDay(raw, "UTC") : String(raw).slice(0, 10).replaceAll("-", "/");
    if (def?.type === "datetime") return formatDayTime(raw instanceof Date ? raw.toISOString() : String(raw), timeZone);
    if (def?.type === "money") return moneyText(modes[field], raw, currency);
    return String(raw);
  };
  const plain = (field: string, extra: Partial<PaymentsFact> = {}): PaymentsFact => ({ label: label(field), value: value(field), ...extra });
  const ref = (field: string, target: string): PaymentsFact => {
    const raw = record[field];
    return { label: label(field), value: value(field), ...(typeof raw === "string" && modes[field] !== "masked" && modes[field] !== "hidden" && linkable.has(target) ? { link: { entity: target, id: raw } } : {}) };
  };
  const money = (field: string) => moneyText(modes[field], record[field], currency);
  const lineMoney = (row: Record<string, unknown>, field: string) => moneyText(lineModes[field], row[field], currency);
  const kindLabel = (kind: string) => (t.has(`payments.values.withholding_kind.${kind}`) ? t(`payments.values.withholding_kind.${kind}`) : kind);

  const stored = Array.isArray(record.allocations) ? (record.allocations as Record<string, unknown>[]) : [];
  const allocations: AllocationView[] = stored.map((a) => {
    const number = typeof a.invoice_number === "string" && a.invoice_number ? a.invoice_number : MASKED;
    const held = lineModes.withholdings === "masked" || lineModes.withholdings === "hidden" ? [] : Array.isArray(a.withholdings) ? (a.withholdings as Record<string, unknown>[]) : [];
    return {
      invoiceId: String(a.invoice_id ?? ""),
      invoiceNumber: number,
      linkable: typeof a.invoice_id === "string" && linkable.has("invoicing.invoice") && lineModes.invoice_id !== "masked",
      amount: lineMoney(a, "amount"),
      cash: lineMoney(a, "cash_amount"),
      withholdingTotal: lineMoney(a, "withholding_total"),
      withholdings: held.map((w) => ({
        kind: kindLabel(String(w.kind ?? "")),
        code: String(w.code ?? ""),
        rate: `${String(w.rate ?? "").replace(".", ",")} %`,
        base: moneyText(undefined, w.base, currency),
        amount: moneyText(undefined, w.amount, currency),
      })),
    };
  });

  const status = String(record.status ?? "posted");
  const facts: PaymentsFact[] = [
    ref("party_id", "core.party"),
    ref("method_id", "payments.method"),
    ref("cash_box_id", "payments.cash_box"),
    plain("date"),
    plain("reference", { mono: true }),
    plain("notes"),
    ...(status === "voided" ? [plain("voided_at"), plain("void_reason", { testId: "receipt-void-reason" })] : []),
  ];
  const withholdings = Number(record.withholding_total ?? 0);
  const advance = Number(record.advance ?? 0);
  const notes: ReceiptView["notes"] = [];
  if (status === "voided") notes.push({ tone: "danger", key: "voided", values: {} });
  else {
    if (modes.withholding_total !== "masked" && withholdings > 0) notes.push({ tone: "ok", key: "withholdings", values: { amount: money("withholding_total") } });
    else if (allocations.length > 0) notes.push({ tone: "ok", key: "settled", values: {} });
    if (modes.advance !== "masked") notes.push(advance > 0 ? { tone: "info", key: "advance", values: { amount: money("advance") } } : { tone: "gray", key: "no_advance", values: {} });
  }
  const name = typeof record.number === "string" && record.number ? record.number : t("payments.view.this_receipt");
  return {
    facts: facts.filter((f) => f.value !== "—"),
    status,
    statusLabel: t(`grid.values.record_status.${status}`),
    statusTone: STATUS_TONE[status] ?? "gray",
    totals: { amount: money("amount"), applied: money("applied"), withholdings: money("withholding_total"), advance: money("advance") },
    notes,
    allocations,
    allocationsGrid,
    void: status === "posted" && runnable.has(PAYMENTS_STEPS["payments.receipt"]!.void!) ? { name, invoices: allocations.map((a) => ({ number: a.invoiceNumber, amount: a.amount })) } : null,
  };
}

/** The receipts that paid an invoice, as payments publishes them (payments.v_invoice_allocations, rule 3), for the invoice's page. */
export async function receiptsOfInvoice(caller: Caller, invoiceId: string): Promise<{ id: string; number: string; status: string }[]> {
  const deps = processDeps();
  if (!(await linkableEntities(deps, caller.claims, ["payments.receipt"])).has("payments.receipt")) return [];
  // The view is published unmasked (rule 3): name the receipts only to who sees their number and status as they are (final review I-2).
  const receipt = gridEntity(deps.registry, "payments.receipt");
  const modes = receipt ? (await gridPageAccess(deps.sql, caller.claims, receipt)).modes : {};
  if (!receipt || ["number", "status"].some((f) => (modes[f] ?? "visible") !== "visible")) return [];
  try {
    return await withClaims(deps.sql, caller.claims, (tx) => tx<{ id: string; number: string; status: string }[]>`
      select receipt_id as id, coalesce(receipt_number, '') as number, receipt_status as status
      from payments.v_invoice_allocations where invoice_id = ${invoiceId} order by date, receipt_number`);
  } catch {
    // Payments not installed in this database (its schema missing): no receipts to name.
    return [];
  }
}
