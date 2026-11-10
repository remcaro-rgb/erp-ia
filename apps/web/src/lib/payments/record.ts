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
import { openAdvancesFor } from "./advances";

// What the pages of the payments records need besides the record (plan 2B Task 24b, prototype 2B «Recibo de caja RC-0088»), read as the
// caller through the masked views and the grid (rule 14): a medio de pago's DIAN codes (the country pack's table 13.3.4.2); «Registrar
// pago»'s medios de pago and cajas (usable ones, masked views through the grid), the customer box's fields and whether invoices link
// (rule 21); and for a stored receipt its facts (references link to their records), its money in the money format (rule 23, masked reads
// masked), its state chip, what it applied to each invoice with the withholdings (Asignaciones: the universal grid, rule 20, and the
// certificate lines) and «Anular recibo» when the caller may run it. The steps are an allowlist keyed by entity (`PAYMENTS_STEPS`): the
// server action picks the process from the entity and the step's name, never from the client.

export type PaymentsFormKind = "method" | "cash_box" | "receipt" | "advance_application";

/** The payments entities with a full record page, and their form. */
export const PAYMENTS_FORMS: Readonly<Record<string, PaymentsFormKind>> = {
  "payments.method": "method",
  "payments.cash_box": "cash_box",
  "payments.receipt": "receipt",
  "payments.advance_application": "advance_application",
};

/**
 * The steps a stored receipt's or application's screen runs, by entity and step name: «Anular recibo» (step-up) reverses the receipt's entry;
 * «Deshacer aplicación» (step-up, plan 2B.2 Task 36) voids an application of an advance and reverses its entry.
 */
export const PAYMENTS_STEPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "payments.receipt": { void: "payments.payment.void" },
  "payments.advance_application": { undo: "payments.advance.undo" },
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

/** One application drawn on a receipt's advance, as the «Anticipos» section lists it. */
export interface AdvanceApplicationView {
  id: string;
  number: string;
  date: string;
  status: string;
  statusLabel: string;
  statusTone: Tone;
  /** What this application draws from the receipt's advance. */
  amount: string;
  linkable: boolean;
  /** «Deshacer aplicación» (null: the caller may not run it, or the application is already undone). */
  undo: { name: string; invoices: { number: string; amount: string }[] } | null;
}

/** The «Anticipos» section of a posted receipt that holds an advance (plan 2B.2 Task 36, R36-9): what is applied and left, the applications and «Aplicar a facturas». */
export interface AdvanceSection {
  /** `forbidden`: the caller does not see the figures the section is made of (rule 14): it says so and offers nothing. */
  access: "ok" | "forbidden";
  partyId: string | null;
  today: string;
  advance: string;
  applied: string;
  remaining: string;
  /** What is left to apply (0 when nothing, or when the figures are not visible). */
  remainingAmount: number;
  applications: AdvanceApplicationView[];
  /** False: the caller may not read the lines or a field the list is filtered or sorted by (rule 14): the list is not shown, never guessed or empty. */
  applicationsAvailable: boolean;
  /** «Aplicar a facturas»: the caller may run it, and the advance has something left. */
  canApply: boolean;
  invoicesLinkable: boolean;
}

export interface ApplicationLineView {
  receiptId: string;
  receiptNumber: string;
  receiptLinkable: boolean;
  invoiceId: string;
  invoiceNumber: string;
  invoiceLinkable: boolean;
  amount: string;
}

/** A stored application of an advance: its facts, the lines (which advance receipt paid which invoice) and «Deshacer aplicación». */
export interface ApplicationView {
  facts: PaymentsFact[];
  status: string;
  statusLabel: string;
  statusTone: Tone;
  total: string;
  lines: ApplicationLineView[];
  note: "posted" | "voided";
  undo: { name: string; invoices: { number: string; amount: string }[] } | null;
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
  /** The advance's section (null: the receipt is not posted or has no advance). */
  advances: AdvanceSection | null;
}

export interface PaymentsFormData {
  kind: "payments";
  payments: PaymentsFormKind;
  today: string;
  /** The company's currency: a method in another one makes a foreign receipt (plan 2B.2 Task 34.5). */
  companyCurrency: string;
  /** A medio de pago's «Código DIAN» options. */
  meansCodes: CodeOption[];
  /** «Registrar pago»: the usable medios de pago and cajas. */
  methods: MethodOption[];
  cashBoxes: CodeOption[];
  party: LookupSource;
  invoicesLinkable: boolean;
  view: ReceiptView | null;
  /** A stored application of an advance. */
  application: ApplicationView | null;
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
    const [row] = await tx<{ today: string; country: string; currency: string }[]>`
      select (now() at time zone timezone)::date::text as today, country_code as country, trim(currency_code) as currency from kernel.companies where id = ${caller.claims.active_company_id}`;
    return { today: row?.today ?? new Date().toISOString().slice(0, 10), country: row?.country ?? "CO", currency: row?.currency ?? "COP" };
  });
  const base: PaymentsFormData = { kind: "payments", payments: kind, today: company.today, companyCurrency: company.currency, meansCodes: [], methods: [], cashBoxes: [], party: { fields: [], entityLabel: t("entity.core.party") }, invoicesLinkable: false, view: null, application: null };
  if (kind === "method") {
    const means = countryPack(company.country).einvoice?.paymentMeans ?? [];
    const key = (code: string) => `invoicing.values.payment_means.${code.toLowerCase()}`;
    return { ...base, meansCodes: means.map((code) => ({ code, name: t.has(key(code)) ? t(key(code)) : code })) };
  }
  if (kind === "cash_box") return base;
  // An application of an advance is written by «Aplicar a facturas» on the receipt that holds the advance: its page only shows the stored one.
  if (kind === "advance_application") return { ...base, application: record ? await applicationView(caller, record) : null };
  if (record) return { ...base, view: await receiptView(caller, record, company.today) };
  // «Registrar pago»: the medios de pago and cajas a receipt may name (active ones, as the caller sees them in their grids).
  const active = [{ field: "is_active", op: "eq" as const, value: true }];
  const [methods, boxes, party, linkable] = await Promise.all([
    gridRows(caller, "payments.method", { filters: active, sort: [{ field: "name", dir: "asc" }], page: 1, pageSize: 200, columns: ["name", "kind", "code", "currency", "status"] }),
    gridRows(caller, "payments.cash_box", { filters: active, sort: [{ field: "code", dir: "asc" }], page: 1, pageSize: 200, columns: ["code", "name", "status"] }),
    lookupSource(caller, "core.party"),
    linkableEntities(deps, caller.claims, ["invoicing.invoice"]),
  ]);
  // A maestro waiting for approval (or not approved) is not usable in a document (the lifecycle's gate): it is not offered.
  const usable = (r: Record<string, unknown>) => !["draft", "pending", "rejected"].includes(String(r.status ?? ""));
  return {
    ...base,
    methods: methods.rows.filter(usable).map((m) => ({ id: String(m.id), name: String(m.name ?? m.code ?? m.id), kind: String(m.kind ?? "other"), ...(typeof m.currency === "string" && m.currency ? { currency: m.currency.trim() } : {}) })),
    cashBoxes: boxes.rows.filter(usable).map((b) => ({ code: String(b.id), name: `${String(b.code ?? "")} · ${String(b.name ?? "")}` })),
    party: party ?? base.party,
    invoicesLinkable: linkable.has("invoicing.invoice"),
  };
}

/** The facts, totals, allocations, grid and «Anular recibo» of a stored receipt. */
async function receiptView(caller: Caller, record: Row, today: string): Promise<ReceiptView> {
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
    runnableProcesses(deps.sql, deps.registry, caller.claims, [...Object.values(PAYMENTS_STEPS["payments.receipt"]!), ...Object.values(PAYMENTS_STEPS["payments.advance_application"]!), "payments.advance.apply"]),
    linkableEntities(deps, caller.claims, ["core.party", "payments.method", "payments.cash_box", "invoicing.invoice", "payments.advance_application"]),
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
    advances: status === "posted" && advance > 0 ? await advanceSection({ caller, record, modes, money, currency, runnable, linkable, today, t }) : null,
  };
}

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/**
 * The «Anticipos» section: the advance, what applications drew and what is left (payments.advance.open, which answers `forbidden` when the caller
 * does not see the figures, rule 14), the applications drawn on this receipt (through the grid, as the caller) and the actions the caller may run.
 */
async function advanceSection(args: {
  caller: Caller;
  record: Row;
  modes: Record<string, FieldMode>;
  money: (field: string) => string;
  currency: string | undefined;
  runnable: Set<string>;
  linkable: Set<string>;
  today: string;
  t: Translate;
}): Promise<AdvanceSection> {
  const { caller, record, modes, money, currency, runnable, linkable, today, t } = args;
  const partyId = typeof record.party_id === "string" && modes.party_id !== "masked" && modes.party_id !== "hidden" ? record.party_id : null;
  const none: AdvanceSection = { access: "forbidden", partyId, today, advance: money("advance"), applied: MASKED, remaining: MASKED, remainingAmount: 0, applications: [], applicationsAvailable: false, canApply: false, invoicesLinkable: linkable.has("invoicing.invoice") };
  if (!partyId) return none;
  const open = await openAdvancesFor(caller, partyId);
  if (!open.ok) return none;
  const advance = Number(record.advance ?? 0);
  // The consult lists only what has something left: a receipt that is not in it has applied its whole advance.
  const mine = open.advances.find((a) => a.receiptId === record.id);
  const applied = mine ? mine.applied : advance;
  const remaining = mine ? mine.remaining : 0;
  const amountText = (n: number) => moneyText(undefined, n, currency);

  // The applications drawn on this receipt, through the grid over the lines (as the caller): the lines of this receipt name the applications, and
  // the lines of those applications say which invoices an undo gives back. A masked or hidden field never filters or sorts (rule 14), and a grid
  // the caller may not read is not guessed: the list is then unavailable.
  const deps = processDeps();
  const lineDef = gridEntity(deps.registry, "payments.advance_application_line");
  const appDef = gridEntity(deps.registry, "payments.advance_application");
  const visibleAll = async (def: NonNullable<typeof lineDef>, fields: string[]) => {
    const { modes: m } = await gridPageAccess(deps.sql, caller.claims, def);
    return fields.every((f) => (m[f] ?? "visible") === "visible");
  };
  const listable =
    !!lineDef &&
    !!appDef &&
    !(await gridDenial(deps, caller.claims, lineDef)) &&
    !(await gridDenial(deps, caller.claims, appDef)) &&
    (await visibleAll(lineDef, ["application_id", "receipt_id", "line_no", "invoice_number", "amount"])) &&
    (await visibleAll(appDef, ["seq", "number", "date", "status"]));
  const base = { access: "ok" as const, partyId, today, advance: money("advance"), applied: amountText(applied), remaining: amountText(remaining), remainingAmount: remaining, invoicesLinkable: linkable.has("invoicing.invoice") };
  const canApply = runnable.has("payments.advance.apply") && remaining > 0;
  if (!listable) return { ...base, applications: [], applicationsAvailable: false, canApply };
  const lineQuery = { sort: [{ field: "line_no", dir: "asc" as const }], page: 1, pageSize: 500, columns: ["application_id", "receipt_id", "invoice_number", "amount"] };
  const mineLines = await gridRows(caller, "payments.advance_application_line", { ...lineQuery, filters: [{ field: "receipt_id", op: "eq", value: record.id }] });
  const ids = [...new Set(mineLines.rows.map((r) => String(r.application_id)))];
  // The `in` filter takes at most 100 values: the ids go in chunks.
  const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, i * 100 + 100));
  const applicationRows = (await Promise.all(chunks.map((c) => gridRows(caller, "payments.advance_application", { filters: [{ field: "id", op: "in", value: c }], sort: [{ field: "seq", dir: "asc" }], page: 1, pageSize: 500, columns: ["number", "date", "status"] })))).flatMap((r) => r.rows);
  const lineRows = (await Promise.all(chunks.map((c) => gridRows(caller, "payments.advance_application_line", { ...lineQuery, filters: [{ field: "application_id", op: "in", value: c }] })))).flatMap((r) => r.rows);
  const views: AdvanceApplicationView[] = applicationRows.map((a) => {
    const id = String(a.id);
    const status = String(a.status ?? "posted");
    const number = typeof a.number === "string" && a.number ? a.number : MASKED;
    const drawn = mineLines.rows.filter((l) => l.application_id === id).reduce((sum, l) => sum + Math.round(Number(l.amount ?? 0) * 100), 0) / 100;
    return {
      id,
      number,
      date: typeof a.date === "string" ? a.date.slice(0, 10).replaceAll("-", "/") : a.date instanceof Date ? formatDay(a.date, "UTC") : "—",
      status,
      statusLabel: t(`grid.values.record_status.${status}`),
      statusTone: STATUS_TONE[status] ?? "gray",
      amount: amountText(drawn),
      linkable: linkable.has("payments.advance_application"),
      undo:
        status === "posted" && runnable.has(PAYMENTS_STEPS["payments.advance_application"]!.undo!)
          ? { name: number, invoices: lineRows.filter((l) => l.application_id === id).map((l) => ({ number: String(l.invoice_number ?? MASKED), amount: amountText(Number(l.amount ?? 0)) })) }
          : null,
    };
  });
  return { ...base, applications: views, applicationsAvailable: true, canApply };
}

/** The facts, lines and «Deshacer aplicación» of a stored application (read only). */
async function applicationView(caller: Caller, record: Row): Promise<ApplicationView> {
  const deps = processDeps();
  const t = await getTranslations();
  const entity = deps.registry.entity("payments.advance_application");
  const header: Record<string, unknown> = { ...record };
  const { timeZone } = await withClaims(deps.sql, caller.claims, async (tx) => {
    await addRefLabels(tx, deps.registry, entity, [header]);
    const [company] = await tx<{ timezone: string }[]>`select timezone from kernel.companies where id = ${caller.claims.active_company_id}`;
    return { timeZone: company?.timezone };
  });
  const gridDef = gridEntity(deps.registry, entity.id);
  const lineDef = gridEntity(deps.registry, "payments.advance_application_line");
  const [runnable, linkable, access, lineAccess] = await Promise.all([
    runnableProcesses(deps.sql, deps.registry, caller.claims, Object.values(PAYMENTS_STEPS["payments.advance_application"]!)),
    linkableEntities(deps, caller.claims, ["core.party", "payments.receipt", "invoicing.invoice"]),
    gridDef ? gridPageAccess(deps.sql, caller.claims, gridDef) : Promise.resolve(null),
    lineDef ? gridPageAccess(deps.sql, caller.claims, lineDef) : Promise.resolve(null),
  ]);
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
    if (def?.type === "date") return raw instanceof Date ? formatDay(raw, "UTC") : String(raw).slice(0, 10).replaceAll("-", "/");
    if (def?.type === "datetime") return formatDayTime(raw instanceof Date ? raw.toISOString() : String(raw), timeZone);
    if (def?.type === "money") return moneyText(modes[field], raw, currency);
    return String(raw);
  };
  const plain = (field: string, extra: Partial<PaymentsFact> = {}): PaymentsFact => ({ label: label(field), value: value(field), ...extra });
  const partyRaw = record.party_id;
  const status = String(record.status ?? "posted");
  const facts: PaymentsFact[] = [
    { label: label("party_id"), value: value("party_id"), ...(typeof partyRaw === "string" && modes.party_id !== "masked" && modes.party_id !== "hidden" && linkable.has("core.party") ? { link: { entity: "core.party", id: partyRaw } } : {}) },
    plain("date"),
    ...(status === "voided" ? [plain("voided_at"), plain("void_reason", { testId: "application-void-reason" })] : []),
  ];
  const lineMoney = (row: Record<string, unknown>, field: string) => moneyText(lineModes[field], row[field], currency);
  const stored = Array.isArray(record.lines) ? (record.lines as Record<string, unknown>[]) : [];
  const lines: ApplicationLineView[] = stored.map((l) => ({
    receiptId: String(l.receipt_id ?? ""),
    receiptNumber: typeof l.receipt_number === "string" && l.receipt_number ? l.receipt_number : MASKED,
    receiptLinkable: typeof l.receipt_id === "string" && linkable.has("payments.receipt") && lineModes.receipt_id !== "masked",
    invoiceId: String(l.invoice_id ?? ""),
    invoiceNumber: typeof l.invoice_number === "string" && l.invoice_number ? l.invoice_number : MASKED,
    invoiceLinkable: typeof l.invoice_id === "string" && linkable.has("invoicing.invoice") && lineModes.invoice_id !== "masked",
    amount: lineMoney(l, "amount"),
  }));
  const name = typeof record.number === "string" && record.number ? record.number : t("payments.pages.advance.view.this_application");
  return {
    facts: facts.filter((f) => f.value !== "—"),
    status,
    statusLabel: t(`grid.values.record_status.${status}`),
    statusTone: STATUS_TONE[status] ?? "gray",
    total: moneyText(modes.total, record.total, currency),
    lines,
    note: status === "voided" ? "voided" : "posted",
    undo: status === "posted" && runnable.has(PAYMENTS_STEPS["payments.advance_application"]!.undo!) ? { name, invoices: lines.map((l) => ({ number: l.invoiceNumber, amount: l.amount })) } : null,
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
