/**
 * The demo ledger of Café del Norte S.A.S. (Task 31): what `pnpm db:seed` leaves in Contabilidad. LOCAL USE ONLY, like the
 * rest of the seed; every write goes through a registered process (rule 1) as Laura (the admin, with a fresh step-up where
 * the process asks for one) or, for the pending provision, as Andrés (the contador). In order:
 *
 *  1. `accounting.chart.seed` (the Colombian PUC, mappings, the seven Fuentes, the posting rules, 2026 and its 12 periods).
 *     chart.seed starts the ledger today; the demo has ten months of history, so `settings.ledger_starts_on` is moved to
 *     2026-01-01 with one SQL update: no process edits it (settings.update has no such field), and the seed is the only
 *     writer that needs it.
 *  2. Two auxiliaries under 111005 (Davivienda, Bancolombia) and the mappings that use them, the returns account for credit notes,
 *     the revenue accounts of the categories bebidas and comida.
 *  3. The analytic masters: 3 centros de costo (Tiendas is a group of Chapinero and Usaquén), 2 auxiliares abiertos, 2 ítems,
 *     4 unidades de negocio; `settings.update` turns the three optional dimensions on.
 *  4. Grants: the accounting processes of the contador and the cajero, `entry.approve` raised to step-up, and the security by
 *     account (5105, class 3, Davivienda).
 *  5. The 2026 opening balances (`opening.create` + `opening.post`), 40 posted entries January to October from the posting
 *     fixtures of design §5.4 (synthetic outbox rows delivered to the accounting consumer, as the dispatch workflow does),
 *     and the manual notes of October.
 *  6. January to September closed (`period.close`, one TOTP each); four-eyes turned on and Andrés' pending provision.
 *
 * Idempotent: every stage looks at what exists first and adds only what is missing.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { accounting } from "@erp/module-accounting";
import { ATTACHMENT_PROCESSES, buildConsumerContext, consumers, enqueueEvent, runProcess, type Caller, type RunProcessDeps } from "@erp/kernel";
import { DEMO_COMPANY_ID, DEMO_ROLE_IDS } from "./accounts";
import { DEMO_YEAR, LEDGER_STARTS_ON, BANCOLOMBIA, HOTEL_CUMBRE, BOSQUE, TRILLADORA, ELECTRIC, OPENING_LINES, INVOICES, CREDIT_NOTES, ANNULMENT_NOTES, type InvoiceSpec } from "./ledger-data";

export { DEMO_YEAR, LEDGER_STARTS_ON, BANCOLOMBIA, EXITO, COLINA, HOTEL_CUMBRE, CARIBE_EXPRESS, SOL_DEL_CARIBE, CATERING_ANDES, ANDINAS, BOSQUE, TRILLADORA, TOSTADORA, ELECTRIC, OPENING_LINES, INVOICES, CREDIT_NOTES, ANNULMENT_NOTES, type InvoiceSpec } from "./ledger-data";

/** A signed-in demo account: the caller of its processes and, when it has a second step, a fresh step-up. */
export interface DemoSession {
  caller: Caller;
  stepUp(): Promise<Caller>;
}

interface Who {
  laura: DemoSession;
  andres: DemoSession;
  /** Auth user ids by e-mail. */
  ids: Map<string, string>;
}


type Run = <T = { id: string }>(session: DemoSession, processId: string, input: unknown, options?: { stepUp?: boolean }) => Promise<T>;

const money = (n: number) => Math.round(n);
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** A fixed UUID v7-shaped id for the event payloads, so a rerun names the same documents. */
export const documentId = (kind: "a" | "b" | "c" | "d" | "e", n: number) => `019a2c4e-0000-7000-8000-${kind}${pad(n, 11)}`;

// ---------------------------------------------------------------------------------------------------------------------
// The data


export interface Node {
  code: string;
  name: string;
  kind: "group" | "leaf";
  parent?: string;
}

export const COST_CENTERS: Node[] = [
  { code: "ADM", name: "Administración", kind: "leaf" },
  { code: "TOS", name: "Tostión", kind: "leaf" },
  { code: "TIE", name: "Tiendas", kind: "group" },
  { code: "CHA", name: "Tienda Chapinero", kind: "leaf", parent: "TIE" },
  { code: "USA", name: "Tienda Usaquén", kind: "leaf", parent: "TIE" },
];
export const OPEN_AUXILIARIES: Node[] = [
  { code: "PRY", name: "Proyectos", kind: "group" },
  { code: "PRY-EXP", name: "Exportación piloto", kind: "leaf", parent: "PRY" },
  { code: "VEH", name: "Vehículos", kind: "group" },
  { code: "VEH-NPR", name: "Camioneta NPR", kind: "leaf", parent: "VEH" },
];
export const ITEMS: Node[] = [
  { code: "CAF", name: "Café", kind: "group" },
  { code: "CAF-500", name: "Café tostado 500 g", kind: "leaf", parent: "CAF" },
  { code: "BEB", name: "Bebidas", kind: "group" },
  { code: "BEB-ESP", name: "Espresso", kind: "leaf", parent: "BEB" },
];
export const BUSINESS_UNITS: Node[] = [
  { code: "CON", name: "Consumo", kind: "group" },
  { code: "CON-TIE", name: "Tiendas", kind: "leaf", parent: "CON" },
  { code: "CON-WEB", name: "Web", kind: "leaf", parent: "CON" },
  { code: "INS", name: "Institucional", kind: "group" },
  { code: "INS-HOR", name: "Horeca", kind: "leaf", parent: "INS" },
  { code: "INS-DIS", name: "Distribuidores", kind: "leaf", parent: "INS" },
];


export const COGS = [
  { number: "CV-01", date: "2026-02-28", cost: 3_000_000, costCenter: "TOS" },
  { number: "CV-02", date: "2026-03-31", cost: 4_000_000, costCenter: "TOS" },
  { number: "CV-03", date: "2026-04-30", cost: 3_500_000, costCenter: "TOS" },
  { number: "CV-04", date: "2026-06-30", cost: 5_000_000, costCenter: "TOS" },
  { number: "CV-05", date: "2026-08-31", cost: 4_500_000, costCenter: "TOS" },
  { number: "CV-06", date: "2026-09-30", cost: 4_000_000, costCenter: "TOS" },
  { number: "CV-07", date: "2026-10-28", cost: 420_000, costCenter: "CHA" },
];

export const ADJUSTMENTS = [
  { number: "AJ-11", date: "2026-05-31", value: -120_000, costCenter: "TOS" },
  { number: "AJ-12", date: "2026-10-29", value: -35_000, costCenter: "TOS" },
];

/** A manual comprobante line with its party and cost center named by document number and code. */
export interface SampleLine {
  accountCode: string;
  partyDocument?: string;
  costCenter?: string;
  debit?: number;
  credit?: number;
  description: string;
}

/** The maintenance supplier: services, retefuente 4 %, a payable on 2335 (not gated by invoice readiness). */
export const BARISTA_PRO = "900864213";

/**
 * October's sample comprobantes of the purchase side (owner order 2026-11-02): a purchase of green coffee with IVA 5 %, retefuente
 * 2,5 %, ReteIVA 15 % and ReteICA 4,14 ‰, a return to the supplier, the payment of the opening payable, a maintenance service, the
 * social benefits provision and the bank's interest. Every line follows the chart's demands: parties on groups 13 and 22 to 25,
 * cost centers on classes 4 to 7.
 */
export const SAMPLE_COMPROBANTES: { description: string; date: string; lines: SampleLine[] }[] = [
  {
    description: "Compra de café verde a Trilladora La Montaña",
    date: "2026-10-06",
    lines: [
      { accountCode: "143505", debit: 10_000_000, description: "Café verde excelso, 800 kg" },
      { accountCode: "240810", partyDocument: TRILLADORA, debit: 500_000, description: "IVA descontable 5 %" },
      { accountCode: "236540", partyDocument: TRILLADORA, credit: 250_000, description: "Retención en la fuente por compras 2,5 %" },
      { accountCode: "236701", partyDocument: TRILLADORA, credit: 75_000, description: "ReteIVA 15 % del IVA" },
      { accountCode: "236801", partyDocument: TRILLADORA, credit: 41_400, description: "ReteICA 4,14 por mil" },
      { accountCode: "220505", partyDocument: TRILLADORA, credit: 10_133_600, description: "Factura de compra FC-8812" },
    ],
  },
  {
    description: "Devolución de café verde a Trilladora La Montaña",
    date: "2026-10-09",
    lines: [
      { accountCode: "220505", partyDocument: TRILLADORA, debit: 1_050_000, description: "Nota crédito del proveedor NC-221" },
      { accountCode: "143505", credit: 1_000_000, description: "Café verde devuelto, 80 kg" },
      { accountCode: "240810", partyDocument: TRILLADORA, credit: 50_000, description: "IVA descontable de la devolución" },
    ],
  },
  {
    description: "Pago a Trilladora La Montaña",
    date: "2026-10-15",
    lines: [
      { accountCode: "220505", partyDocument: TRILLADORA, debit: 18_000_000, description: "Saldo inicial de proveedores" },
      { accountCode: "530505", costCenter: "ADM", debit: 15_000, description: "Comisión por transferencia" },
      { accountCode: "11100502", credit: 18_015_000, description: "Transferencia Bancolombia" },
    ],
  },
  {
    description: "Mantenimiento de la tostadora",
    date: "2026-10-22",
    lines: [
      { accountCode: "514515", costCenter: "TOS", debit: 1_200_000, description: "Mantenimiento preventivo de la tostadora" },
      { accountCode: "240810", partyDocument: BARISTA_PRO, debit: 228_000, description: "IVA descontable 19 %" },
      { accountCode: "236525", partyDocument: BARISTA_PRO, credit: 48_000, description: "Retención en la fuente por servicios 4 %" },
      { accountCode: "233535", partyDocument: BARISTA_PRO, credit: 1_380_000, description: "Servicio de mantenimiento por pagar" },
    ],
  },
  {
    description: "Provisión de prestaciones sociales de octubre",
    date: "2026-10-31",
    lines: [
      { accountCode: "510530", costCenter: "ADM", debit: 1_457_750, description: "Cesantías 8,33 %" },
      { accountCode: "510533", costCenter: "ADM", debit: 175_000, description: "Intereses sobre cesantías 1 %" },
      { accountCode: "510536", costCenter: "ADM", debit: 1_457_750, description: "Prima de servicios 8,33 %" },
      { accountCode: "510539", costCenter: "ADM", debit: 729_750, description: "Vacaciones 4,17 %" },
      { accountCode: "261005", credit: 1_457_750, description: "Provisión de cesantías" },
      { accountCode: "261010", credit: 175_000, description: "Provisión de intereses sobre cesantías" },
      { accountCode: "261020", credit: 1_457_750, description: "Provisión de prima de servicios" },
      { accountCode: "261015", credit: 729_750, description: "Provisión de vacaciones" },
    ],
  },
  {
    description: "Rendimientos financieros de octubre",
    date: "2026-10-31",
    lines: [
      { accountCode: "11100502", debit: 320_000, description: "Intereses de la cuenta de ahorros" },
      { accountCode: "421005", partyDocument: BANCOLOMBIA, costCenter: "ADM", credit: 320_000, description: "Intereses financieros" },
    ],
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// Stages

const one = async <T>(rows: Promise<T[]>): Promise<T | undefined> => (await rows)[0];

/** `accounting.chart.seed`, then the start of the ledger on 1 January (see the header). */
async function setUpLedger(sql: Sql, run: Run, laura: DemoSession): Promise<void> {
  await run(laura, "accounting.chart.seed", {}, { stepUp: true });
  const [fy] = await sql`select 1 from accounting.fiscal_years where company_id = ${DEMO_COMPANY_ID} and year = ${DEMO_YEAR}`;
  if (!fy) await run(laura, "accounting.fiscal_year.open", { year: DEMO_YEAR });
  await sql`update accounting.settings set ledger_starts_on = ${LEDGER_STARTS_ON} where company_id = ${DEMO_COMPANY_ID} and ledger_starts_on <> ${LEDGER_STARTS_ON}`;
}

const accountId = async (sql: Sql, code: string): Promise<string> => {
  const row = await one(sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${DEMO_COMPANY_ID} and code = ${code}`);
  if (!row) throw new Error(`demo ledger: account ${code} is not in the chart`);
  return row.id;
};

/** The two bank auxiliaries (a company grows its chart below the subcuenta), and the mappings that use them. */
async function setUpAccounts(sql: Sql, run: Run, laura: DemoSession): Promise<void> {
  for (const [code, name] of [["11100501", "Davivienda cuenta corriente"], ["11100502", "Bancolombia cuenta de ahorros"]] as const) {
    const [exists] = await sql`select 1 from accounting.accounts where company_id = ${DEMO_COMPANY_ID} and code = ${code}`;
    if (!exists) await run(laura, "accounting.account.create", { code, name });
  }
  await run(laura, "accounting.account_role_mapping.update", {
    mappings: [
      { role: "bank", accountId: await accountId(sql, "11100502") },
      { role: "cash", dimension: "payment_method:transfer", accountId: await accountId(sql, "11100501") },
      { role: "revenue", dimension: "category:bebidas", accountId: await accountId(sql, "413505") },
      { role: "revenue", dimension: "category:comida", accountId: await accountId(sql, "413595") },
      { role: "revenue", dimension: "note_reason:return", accountId: await accountId(sql, "417505") },
    ],
  }, { stepUp: true });
}

/** One dimension's nodes: groups first, leaves under them; what exists by code is kept. */
async function setUpNodes(sql: Sql, run: Run, laura: DemoSession, entity: string, table: string, nodes: Node[]): Promise<void> {
  const byCode = new Map((await sql<{ id: string; code: string }[]>`select id, code from ${sql(`accounting.${table}`)} where company_id = ${DEMO_COMPANY_ID}`).map((r) => [r.code, r.id]));
  for (const node of nodes) {
    if (byCode.has(node.code)) continue;
    const { id } = await run(laura, `${entity}.create`, { code: node.code, name: node.name, kind: node.kind, ...(node.parent ? { parentId: byCode.get(node.parent)! } : {}) });
    byCode.set(node.code, id);
  }
}

async function setUpDimensions(sql: Sql, run: Run, laura: DemoSession): Promise<void> {
  await setUpNodes(sql, run, laura, "accounting.cost_center", "cost_centers", COST_CENTERS);
  await setUpNodes(sql, run, laura, "accounting.open_auxiliary", "open_auxiliaries", OPEN_AUXILIARIES);
  await setUpNodes(sql, run, laura, "accounting.item", "items", ITEMS);
  await setUpNodes(sql, run, laura, "accounting.business_unit", "business_units", BUSINESS_UNITS);
  const [settings] = await sql<{ use_open_auxiliaries: boolean; use_items: boolean; use_business_units: boolean }[]>`
    select use_open_auxiliaries, use_items, use_business_units from accounting.settings where company_id = ${DEMO_COMPANY_ID}`;
  if (!settings!.use_open_auxiliaries || !settings!.use_items || !settings!.use_business_units) {
    await run(laura, "accounting.settings.update", { useOpenAuxiliaries: true, useItems: true, useBusinessUnits: true }, { stepUp: true });
  }
}

/** The accountant reads the ledger and writes comprobantes; the cashier reads it and writes drafts (the cashier cannot post). */
async function grantAccounting(run: Run, laura: DemoSession): Promise<void> {
  const ids = accounting.processes.map((p) => ({ id: p.id, kind: p.kind }));
  const consults = ids.filter((p) => p.kind === "consult").map((p) => p.id);
  const entries = ids.filter((p) => /^accounting\.(entry|entry_template|entry_line)\./.test(p.id)).map((p) => p.id);
  const contador = [...new Set([...consults, ...entries, "accounting.opening.create"])];
  const cajero = [...new Set([...consults, ...entries.filter((id) => /^accounting\.entry\.(create|update|void|delete|submit|from_template)$/.test(id))])];
  const attachments = ATTACHMENT_PROCESSES.map((p) => p.id);
  const changes = [
    ...[...contador, ...attachments].map((processId) => ({ roleId: DEMO_ROLE_IDS.contador, processId, allowed: true })),
    ...[...cajero, ...attachments].map((processId) => ({ roleId: DEMO_ROLE_IDS.cajero, processId, allowed: true })),
  ];
  await run(laura, "kernel.admin.permission.set_many", { changes }, { stepUp: true });
}

/** Approving a comprobante asks for the TOTP code (design §6: the admin may raise `entry.approve` to step-up). */
async function raiseEntryPost(sql: Sql, run: Run, laura: DemoSession): Promise<void> {
  const [raised] = await sql`select 1 from kernel.sensitive_processes where company_id = ${DEMO_COMPANY_ID} and process_id = 'accounting.entry.approve'`;
  if (!raised) await run(laura, "kernel.admin.sensitive_process.set", { processId: "accounting.entry.approve", sensitive: true }, { stepUp: true });
}

/** Security by account (design §5.13): 5105 and class 3 are restricted, the Davivienda account is Laura's to post. */
async function setUpAccountSecurity(sql: Sql, run: Run, laura: DemoSession, lauraId: string): Promise<void> {
  const grants = (rows: { kind: "role" | "user"; id: string; view?: boolean; post?: boolean }[]) =>
    rows.map((r) => ({ subjectKind: r.kind, subjectId: r.id, canView: r.view ?? true, canPost: r.post ?? false }));
  const plan: [string, { kind: "role" | "user"; id: string; view?: boolean; post?: boolean }[]][] = [
    ["5105", [{ kind: "role", id: DEMO_ROLE_IDS.contador, post: true }, { kind: "role", id: DEMO_ROLE_IDS.gerente_comercial }]],
    ["3", [{ kind: "role", id: DEMO_ROLE_IDS.contador, post: true }]],
    ["11100501", [{ kind: "user", id: lauraId, post: true }, { kind: "role", id: DEMO_ROLE_IDS.contador }, { kind: "role", id: DEMO_ROLE_IDS.gerente_comercial }]],
  ];
  for (const [code, rows] of plan) {
    const id = await accountId(sql, code);
    const [restricted] = await sql`select 1 from accounting.accounts where id = ${id} and access = 'restricted'`;
    if (!restricted) await run(laura, "accounting.account_permission.update", { accountId: id, access: "restricted", grants: grants(rows) }, { stepUp: true });
  }
}

/** The 2026 opening balances: a draft in Apertura, posted by the human step. */
async function setUpOpening(sql: Sql, run: Run, laura: DemoSession): Promise<void> {
  const [done] = await sql`select 1 from accounting.entries where company_id = ${DEMO_COMPANY_ID} and is_opening and status = 'posted'`;
  if (done) return;
  const draft = await one(sql<{ id: string }[]>`select id from accounting.entries where company_id = ${DEMO_COMPANY_ID} and is_opening and status = 'draft'`);
  const id = draft?.id ?? (await run(laura, "accounting.opening.create", { date: LEDGER_STARTS_ON, description: `Saldos iniciales ${DEMO_YEAR}`, lines: OPENING_LINES })).id;
  await run(laura, "accounting.opening.post", { id }, { stepUp: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// The posted history

/** A synthetic outbox event delivered to the accounting consumer, as `dispatchOutboxRow` does (the CLI has no workflow world). */
async function deliver(sql: Sql, deps: RunProcessDeps, event: string, payload: Record<string, unknown>): Promise<boolean> {
  const number = String(payload.number);
  const [seen] = await sql`select 1 from kernel.outbox where company_id = ${DEMO_COMPANY_ID} and event = ${event} and payload->>'number' = ${number}`;
  if (seen) return false;
  const chainId = randomUUID();
  const outboxId = await sql.begin((tx) => enqueueEvent(tx, { companyId: DEMO_COMPANY_ID, event, payload, chainId }));
  const [row] = await sql<{ id: string; event: string; payload: unknown; created_at: Date }[]>`select id, event, payload, created_at from kernel.outbox where id = ${outboxId}`;
  const ctx = buildConsumerContext(sql, { id: row!.id, event: row!.event, createdAt: row!.created_at, companyId: DEMO_COMPANY_ID, chainId }, deps.registry);
  // These are the 2A posting fixtures: their documents exist only in the ledger. Only the accounting consumer receives them; the phase 2B
  // modules the seed also loads (invoicing, payments...) consume the same event names for documents of their own tables, which these are not
  // (plan 2B Task 26; scripts/demo/sales.ts posts a real chain through those modules).
  for (const consumer of consumers.for(event).filter((c) => c.moduleId === "accounting")) {
    await consumer.fn(ctx, row!.payload);
    await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${outboxId}, ${consumer.moduleId}) on conflict do nothing`;
  }
  await sql`update kernel.outbox set dispatched_at = now() where id = ${outboxId}`;
  const [failure] = await sql<{ error_code: string; error_detail: string }[]>`
    select error_code, error_detail from accounting.posting_failures where company_id = ${DEMO_COMPANY_ID} and event_id = ${outboxId} and status = 'pending'`;
  if (failure) throw new Error(`demo ledger: ${event} ${number} did not post: ${failure.error_code} ${failure.error_detail}`);
  return true;
}

async function nodeIds(sql: Sql, table: string): Promise<Map<string, string>> {
  return new Map((await sql<{ id: string; code: string }[]>`select id, code from ${sql(`accounting.${table}`)} where company_id = ${DEMO_COMPANY_ID}`).map((r) => [r.code, r.id]));
}

async function partyIds(sql: Sql): Promise<Map<string, { id: string; name: string }>> {
  return new Map(
    (await sql<{ id: string; document_number: string; name: string }[]>`
      select id, document_number, coalesce(legal_name, trim(concat_ws(' ', first_name, first_surname))) as name from core.parties where company_id = ${DEMO_COMPANY_ID}`).map((p) => [p.document_number, { id: p.id, name: p.name }]),
  );
}

/** The 40 posted entries of January to October, from the §5.4 payloads. Returns how many events were new. */
/** The annulment concept of the Colombian pack's table 13.2.4 (packages/localization/co: ANNULMENT_CONCEPT). */
const ANNULMENT_REASON_CODE = "2";

/**
 * The invoicing.note.issued payload of an annulment, mirroring what invoicing.invoice.void / note.issue_annulment emits (processes/note.ts):
 * a credit note whose amounts are the invoice's, negative (the posting engine flips the side of a negative amount). R53-2: the seed's
 * invoices are ledger events with no invoicing.invoices row, so the seed sends the event itself.
 */
export function annulmentPayload(
  note: { number: string; date: string; invoice: string },
  spec: InvoiceSpec,
  ids: { noteId: string; invoiceId: string; customer: { partyId: string; legalName: string }; costCenterId: string | undefined },
): Record<string, unknown> {
  const base = spec.beverages + spec.food;
  const tax = money(base * 0.19);
  return {
    date: note.date, number: note.number, noteId: ids.noteId, kind: "credit", annulment: true, reasonCode: ANNULMENT_REASON_CODE, dueDate: note.date,
    invoiceId: ids.invoiceId, invoiceNumber: spec.number, customer: ids.customer, costCenterId: ids.costCenterId,
    totals: { total: -(base + tax) },
    lines: [{ subtotal: -spec.beverages, categoryId: "bebidas", costCenterId: ids.costCenterId }, { subtotal: -spec.food, categoryId: "comida", costCenterId: ids.costCenterId }],
    taxes: [{ code: "IVA19", rate: 19, amount: -tax, base: -base }],
  };
}

async function postHistory(sql: Sql, deps: RunProcessDeps): Promise<number> {
  const costCenters = await nodeIds(sql, "cost_centers");
  const units = await nodeIds(sql, "business_units");
  const parties = await partyIds(sql);
  const customer = (document: string) => {
    const p = parties.get(document);
    if (!p) throw new Error(`demo ledger: the party ${document} is not in the demo data`);
    return { partyId: p.id, legalName: p.name };
  };
  let delivered = 0;
  const send = async (event: string, payload: Record<string, unknown>) => {
    if (await deliver(sql, deps, event, payload)) delivered++;
  };

  const issued = new Map<string, { index: number; spec: InvoiceSpec; base: number; total: number }>();
  for (const [i, spec] of INVOICES.entries()) {
    const base = spec.beverages + spec.food;
    const tax = money(base * 0.19);
    issued.set(spec.number, { index: i + 1, spec, base, total: base + tax });
    await send("invoicing.invoice.issued", {
      date: spec.date, number: spec.number, invoiceId: documentId("a", i + 1), dueDate: addDays(spec.date, 30), customer: customer(spec.customer),
      costCenterId: costCenters.get(spec.costCenter), businessUnitId: units.get(spec.businessUnit), totals: { total: base + tax },
      lines: [{ subtotal: spec.beverages, categoryId: "bebidas" }, { subtotal: spec.food, categoryId: "comida" }],
      taxes: [{ code: "IVA19", rate: 19, amount: tax, base }],
    });
  }

  // Receipts: the customer withholds retefuente 2.5 % and ICA Bogotá 0.966 % on the base it pays.
  let receiptNo = 300;
  const receipt = async (spec: InvoiceSpec, index: number) => {
    const { base, total } = issued.get(spec.number)!;
    const share = spec.receipt!.share ?? 1;
    const applied = money(total * share);
    const paidBase = money(base * share);
    const rte = money(paidBase * 0.025);
    const ica = money(paidBase * 0.00966);
    receiptNo++;
    const number = `RC-${receiptNo}`;
    await send("payments.received", {
      date: addDays(spec.date, spec.receipt!.days), number, paymentId: documentId("b", index), method: spec.receipt!.method, amount: applied - rte - ica, applied,
      customer: customer(spec.customer),
      withholdings: {
        income: [{ code: "RTEFTE_COMPRAS_2_5", rate: 2.5, base: paidBase, amount: rte }],
        vat: [],
        ica: [{ code: "RTEICA_BOGOTA_0_966", rate: 0.966, base: paidBase, amount: ica }],
      },
    });
    return { number, date: addDays(spec.date, spec.receipt!.days) };
  };
  let voidedReceipt: { number: string; date: string; index: number } | null = null;
  for (const [i, spec] of INVOICES.entries()) {
    if (!spec.receipt) continue;
    const paid = await receipt(spec, i + 1);
    if (spec.number === "FE-1013") voidedReceipt = { ...paid, index: i + 1 };
  }

  for (const [i, note] of CREDIT_NOTES.entries()) {
    const tax = money(note.subtotal * 0.19);
    await send("invoicing.note.issued", {
      date: note.date, number: note.number, noteId: documentId("e", i + 1), reasonCode: "return", dueDate: note.date, customer: customer(note.customer),
      costCenterId: costCenters.get(note.costCenter), totals: { total: -(note.subtotal + tax) }, lines: [{ subtotal: -note.subtotal }],
      taxes: [{ code: "IVA19", rate: 19, amount: -tax, base: -note.subtotal }],
    });
  }
  for (const [i, cogs] of COGS.entries()) {
    await send("costing.cogs.posted", { date: cogs.date, number: cogs.number, cogsId: documentId("c", i + 1), lines: [{ cost: cogs.cost, costCenterId: costCenters.get(cogs.costCenter) }] });
  }
  for (const [i, adjustment] of ADJUSTMENTS.entries()) {
    await send("inventory.movement.posted", {
      date: adjustment.date, number: adjustment.number, movementId: documentId("d", i + 1), kind: "adjustment",
      lines: [{ value: adjustment.value, costCenterId: costCenters.get(adjustment.costCenter) }],
    });
  }

  // The receipt of FE-1013 voided (open again), and the annulment note of the invoice FE-1015, each in its own open period.
  if (voidedReceipt) await send("payments.payment.voided", { date: addDays(voidedReceipt.date, 3), number: voidedReceipt.number, paymentId: documentId("b", voidedReceipt.index) });
  // FE-1015 is annulled by its credit note of annulment (Task 53.3), numbered after the partial notes.
  for (const [i, note] of ANNULMENT_NOTES.entries()) {
    const spec = issued.get(note.invoice)!;
    await send("invoicing.note.issued", annulmentPayload(note, spec.spec, {
      noteId: documentId("e", CREDIT_NOTES.length + i + 1), invoiceId: documentId("a", spec.index), customer: customer(spec.spec.customer), costCenterId: costCenters.get(spec.spec.costCenter),
    }));
  }
  return delivered;
}

// ---------------------------------------------------------------------------------------------------------------------
// October's manual notes

async function manualNotes(sql: Sql, run: Run, laura: DemoSession): Promise<void> {
  const costCenters = await nodeIds(sql, "cost_centers");
  const parties = await partyIds(sql);
  const cc = (code: string) => costCenters.get(code)!;
  const party = (document: string) => parties.get(document)!.id;
  const notes: { description: string; date: string; reverseOn?: string; lines: Record<string, unknown>[] }[] = [
    {
      description: "Nómina octubre",
      date: "2026-10-28",
      lines: [
        { accountCode: "510506", costCenterId: cc("ADM"), debit: 6_500_000, description: "Sueldos administración" },
        { accountCode: "510506", costCenterId: cc("TOS"), debit: 4_800_000, description: "Sueldos tostión" },
        { accountCode: "510506", costCenterId: cc("CHA"), debit: 3_200_000, description: "Sueldos Tienda Chapinero" },
        { accountCode: "510506", costCenterId: cc("USA"), debit: 3_000_000, description: "Sueldos Tienda Usaquén" },
        { accountCode: "11100502", credit: 17_500_000, description: "Pago de nómina" },
      ],
    },
    {
      description: "Acumulación energía octubre",
      date: "2026-10-30",
      reverseOn: "2026-11-01",
      lines: [
        { accountCode: "513530", costCenterId: cc("TOS"), debit: 1_850_000, description: "Energía eléctrica de octubre por facturar" },
        { accountCode: "233550", partyId: party(ELECTRIC), credit: 1_850_000, description: "Servicios públicos por pagar" },
      ],
    },
    {
      description: "Depósito por identificar",
      date: "2026-10-29",
      lines: [
        { accountCode: "11100501", debit: 500_000, description: "Consignación sin soporte" },
        { accountCode: "238095", partyId: party(HOTEL_CUMBRE), credit: 500_000, description: "Partida por aclarar" },
      ],
    },
  ];
  for (const sample of SAMPLE_COMPROBANTES) {
    notes.push({
      description: sample.description,
      date: sample.date,
      lines: sample.lines.map(({ partyDocument, costCenter, ...line }) => ({
        ...line,
        ...(partyDocument ? { partyId: party(partyDocument) } : {}),
        ...(costCenter ? { costCenterId: cc(costCenter) } : {}),
      })),
    });
  }
  for (const note of notes) {
    const [exists] = await sql`select 1 from accounting.entries where company_id = ${DEMO_COMPANY_ID} and description = ${note.description}`;
    if (exists) continue;
    const { id } = await run(laura, "accounting.entry.create", { date: note.date, description: note.description, ...(note.reverseOn ? { reverseOn: note.reverseOn } : {}), lines: note.lines });
    // Grabar posts it (no approval yet: four-eyes is switched on later, for Andrés' provision).
    await run(laura, "accounting.entry.save", { id });
  }
}

/** January to September closed, one TOTP each (the checks run for real). */
async function closePeriods(sql: Sql, run: Run, laura: DemoSession): Promise<number> {
  const open = await sql<{ id: string; number: number }[]>`
    select p.id, p.number from accounting.periods p join accounting.fiscal_years y on y.id = p.fiscal_year_id
    where p.company_id = ${DEMO_COMPANY_ID} and y.year = ${DEMO_YEAR} and p.number <= 9 and p.status = 'open' order by p.number`;
  for (const period of open) {
    const result = await run<{ closed: boolean; failed: string[] }>(laura, "accounting.period.close", { periodId: period.id }, { stepUp: true });
    if (!result.closed) throw new Error(`demo ledger: period ${period.number} did not close: ${result.failed.join(" · ")}`);
  }
  return open.length;
}

/** Four-eyes on, then Andrés' provision waits for somebody else's approval. */
async function pendingProvision(sql: Sql, run: Run, laura: DemoSession, andres: DemoSession): Promise<void> {
  const [settings] = await sql<{ require_approval_on_manual: boolean }[]>`select require_approval_on_manual from accounting.settings where company_id = ${DEMO_COMPANY_ID}`;
  if (!settings!.require_approval_on_manual) await run(laura, "accounting.settings.update", { requireApprovalOnManual: true }, { stepUp: true });
  const description = "Provisión de arriendo de octubre";
  const [exists] = await sql`select 1 from accounting.entries where company_id = ${DEMO_COMPANY_ID} and description = ${description}`;
  if (exists) return;
  const parties = await partyIds(sql);
  const costCenters = await nodeIds(sql, "cost_centers");
  const { id } = await run(andres, "accounting.entry.create", {
    date: "2026-10-30", description,
    lines: [
      { accountCode: "512010", costCenterId: costCenters.get("ADM"), debit: 2_500_000, description: "Arriendo de octubre" },
      { accountCode: "233540", partyId: parties.get(BOSQUE)!.id, credit: 2_500_000, description: "Arriendo por pagar" },
    ],
  });
  // With approval Grabar leaves it Grabado; Enviar a aprobación makes it wait for somebody else.
  await run(andres, "accounting.entry.save", { id });
  await run(andres, "accounting.entry.submit", { id });
}

export interface AccountingSeedResult {
  entriesFromEvents: number;
  periodsClosed: number;
}

/** The whole demo ledger; see the file header for the stages. */
export async function seedAccounting(sql: Sql, deps: RunProcessDeps, who: Who, lauraId: string): Promise<AccountingSeedResult> {
  const run: Run = async (session, processId, input, options = {}) => {
    const caller = options.stepUp ? await session.stepUp() : session.caller;
    return (await runProcess<never>(deps, caller, processId, input)) as never;
  };
  const { laura, andres } = who;
  await setUpLedger(sql, run, laura);
  await setUpAccounts(sql, run, laura);
  await setUpDimensions(sql, run, laura);
  await grantAccounting(run, laura);
  await raiseEntryPost(sql, run, laura);
  await setUpAccountSecurity(sql, run, laura, lauraId);
  await setUpOpening(sql, run, laura);
  const entriesFromEvents = await postHistory(sql, deps);
  await manualNotes(sql, run, laura);
  const periodsClosed = await closePeriods(sql, run, laura);
  await pendingProvision(sql, run, laura, andres);
  return { entriesFromEvents, periodsClosed };
}
