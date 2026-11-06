import { randomUUID } from "node:crypto";
import { kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, type Caller, type ProcessError } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { einvoicePack } from "@erp/loc-co/einvoice";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { invoicing } from "@erp/module-invoicing";
import { payments } from "../index";

// The payments harness (plan 2B Task 21): core, accounting (the real posting engine on the demo chart), invoicing (sale invoices written by
// hand and issued with «Emitir», posted inline) and payments. The company has a DIAN resolution for invoices valid all the fiscal year, the
// cost center VTA set as the invoicing default (the demo chart's 4135 asks for one), a ready customer and a service (IVA 19 %), and three
// medios de pago: efectivo (cash), transferencia (transfer) and tarjeta (card). The DIAN's acceptance of an invoice is simulated by setting
// its dian_status (the e-invoice workflow and its mock transport are invoicing's tests, Task 17): a receipt is allowed only on an invoice
// the DIAN accepted.

export const registry = new Registry();
export const MODULES = [kernelModule, core, accounting, invoicing, payments];
loadModules(registry, MODULES);
const MODULE_IDS = ["core", "accounting", "invoicing", "payments"];
const PROCESS_IDS = MODULE_IDS.flatMap((m) => registry.processes({ module: m })).map((p) => p.id);

const customer = (documentNumber: string, legalName: string) => ({
  kind: ["customer"], personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@cliente.example",
});

export interface Invoice { id: string; number: string; total: number }
export interface Allocation { invoiceId: string; amount: number; withholdings?: { kind: "income" | "vat" | "ica"; code: string; rate: number; base: number; amount: number }[] }
export interface ReceiptOut {
  id: string; number: string | null; status: string; date: string; partyId: string; methodId: string; amount: number; applied: number; withholdingTotal: number; advance: number;
  allocations: { invoiceId: string; invoiceNumber: string | null; amount: number; cashAmount: number; withholdingTotal: number }[];
}

export type Harness = Awaited<ReturnType<typeof paymentsHarness>>;

export async function paymentsHarness() {
  const sql = testDb();
  registerCountryPack({ ...co, einvoice: einvoicePack });
  for (const m of [core, invoicing, payments]) await syncModuleManifest(sql, m);
  const seed: SeededTenant = await seedTenant(sql, {
    companies: 2,
    users: [{ name: "clerk", companies: [0], role: "member" }],
    entitlements: MODULE_IDS.map((m) => `module:${m}`),
  });
  for (const company of seed.companies) {
    for (const id of PROCESS_IDS) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.adminRoleId}, ${id}) on conflict do nothing`;
    }
  }
  const companyId = seed.companies[0]!.id;
  const otherCompanyId = seed.companies[1]!.id;
  const admin: Caller = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };

  const run = <T = unknown>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const runStepUp = async <T = unknown>(processId: string, input: unknown, caller: Caller = admin) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${companyId}, ${stepUpToken})`;
    return runProcess({ sql, registry }, { ...caller, stepUpToken }, processId, input) as Promise<T>;
  };
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (ProcessError & { details: unknown }) | null;

  const markReady = async (id: string) => {
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'core.party', ${id}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${seed.tenantId}/${companyId}/core.party/${id}/${randomUUID()}.pdf`})`;
    }
  };
  const newCustomer = async (documentNumber: string, legalName: string, ready = true) => {
    const id = (await run<{ id: string }>(admin, "core.party.create", customer(documentNumber, legalName))).id;
    if (ready) await markReady(id);
    return id;
  };

  await runStepUp("accounting.chart.seed", {});
  const year = (await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${companyId}`)[0]!.year;
  await sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${companyId}`;
  const costCenterId = (await sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
  /** The company's today (Bogotá): «Emitir» dates every invoice on it. */
  const today = (await sql<{ d: string }[]>`select (now() at time zone 'America/Bogota')::date::text as d`)[0]!.d;

  const resolution = { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000999, validFrom: `${year}-01-01`, validTo: `${year}-12-31`, technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c" };
  await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, resolution)
            values (${companyId}, 'invoice', ${resolution.prefix}, ${resolution.from}, ${sql.json(resolution as never)})`;
  await runStepUp("invoicing.settings.update", { defaultCostCenterId: costCenterId });

  const partyId = await newCustomer("860002964", "Distribuidora Andina S.A.S.");
  const servicio = (await run<{ id: string }>(admin, "core.product.create", {
    sku: "SRV-01", description: "Instalación", kind: "service", idScheme: "999", uomCode: "94", ivaRate: "19", otherTaxes: [], listPrice: 100000, isFreeSample: false, trackStock: false,
  })).id;

  const methods = {
    cash: (await run<{ id: string }>(admin, "payments.method.create", { code: "cash", name: "Efectivo", kind: "cash", meansCode: "10" })).id,
    transfer: (await run<{ id: string }>(admin, "payments.method.create", { code: "transfer", name: "Transferencia", kind: "transfer", meansCode: "47" })).id,
    card: (await run<{ id: string }>(admin, "payments.method.create", { code: "card", name: "Tarjeta", kind: "card", meansCode: "48" })).id,
  };

  /** An issued invoice of the service (`qty` × 100.000 + IVA 19 %), accepted by the DIAN unless told otherwise. */
  const issuedInvoice = async (qty = 1, options: { partyId?: string; accepted?: boolean; currency?: string; exchangeRate?: number } = {}): Promise<Invoice> => {
    const draft = await run<{ id: string }>(admin, "invoicing.invoice.create", {
      partyId: options.partyId ?? partyId, paymentForm: "2", lines: [{ productId: servicio, qty }],
      ...(options.currency ? { currency: options.currency, exchangeRate: options.exchangeRate } : {}),
    });
    const issued = await run<{ id: string; number: string; total: number }>(admin, "invoicing.invoice.issue", { id: draft.id });
    // The DIAN's answer, as the transport would record it (its status only moves forward: sent, then accepted).
    if (options.accepted !== false) {
      await sql`update invoicing.invoices set dian_status = 'submitted' where id = ${issued.id}`;
      await sql`update invoicing.invoices set dian_status = 'accepted' where id = ${issued.id}`;
    }
    return { id: issued.id, number: issued.number, total: issued.total };
  };

  const receive = (input: { amount: number; allocations?: Allocation[]; method?: keyof typeof methods; partyId?: string; date?: string; idempotencyKey?: string; reference?: string; cashBoxId?: string }, caller: Caller = admin) =>
    run<ReceiptOut>(caller, "payments.payment.receive", {
      partyId: input.partyId ?? partyId, methodId: methods[input.method ?? "transfer"], amount: input.amount, date: input.date ?? today,
      allocations: input.allocations ?? [],
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
      ...(input.cashBoxId ? { cashBoxId: input.cashBoxId } : {}),
    });

  const eventsOf = (name: string, receiptId: string) => sql<{ id: string; event: string; payload: Record<string, unknown>; chain_id: string }[]>`
    select id, event, payload, chain_id from kernel.outbox where company_id = ${companyId} and event = ${name} and payload->>'paymentId' = ${receiptId}`;
  const entriesOfSource = (sourceId: string) => sql<{ id: string; status: string; date: string; source_entity: string; reversal_of_id: string | null; total_debit: string; chain_id: string; journal: string }[]>`
    select e.id, e.status, e.date::text as date, e.source_entity, e.reversal_of_id, e.total_debit::text, e.chain_id, j.code as journal
    from accounting.entries e join accounting.journals j on j.id = e.journal_id where e.company_id = ${companyId} and e.source_record_id = ${sourceId} order by e.posted_at, e.seq`;
  const linesOf = (entryId: string) => sql<{ code: string; debit: string; credit: string; tax_code: string | null; party_id: string | null }[]>`
    select a.code, l.debit::text, l.credit::text, l.tax_code, l.party_id from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entryId} order by l.line_no`;
  /** What the posted receipts settle of an invoice (payments' published view). */
  const paidOf = async (invoiceId: string) => Number((await sql<{ paid: string | null }[]>`select sum(amount)::text as paid from payments.v_invoice_allocations where invoice_id = ${invoiceId} and receipt_status = 'posted'`)[0]?.paid ?? 0);
  /** Everything a refused receipt could have left behind, to compare before and after. */
  const footprint = async () => ({
    receipts: Number((await sql`select count(*)::int as n from payments.receipts where company_id = ${companyId}`)[0]!.n),
    allocations: Number((await sql`select count(*)::int as n from payments.receipt_allocations where company_id = ${companyId}`)[0]!.n),
    entries: Number((await sql`select count(*)::int as n from accounting.entries where company_id = ${companyId}`)[0]!.n),
    failures: Number((await sql`select count(*)::int as n from accounting.posting_failures where company_id = ${companyId}`)[0]!.n),
    events: Number((await sql`select count(*)::int as n from kernel.outbox where company_id = ${companyId} and event like 'payments.%'`)[0]!.n),
    numbers: (await sql<{ next: string }[]>`select next::text from payments.document_numbers where company_id = ${companyId}`).map((r) => r.next),
  });
  const setAccounting = (enabled: boolean) => sql`
    insert into kernel.company_modules (company_id, module_id, enabled, enabled_at) values (${companyId}, 'accounting', ${enabled}, now())
    on conflict (company_id, module_id) do update set enabled = ${enabled}`;

  const cleanup = async () => {
    const companyIds = [companyId, otherCompanyId];
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const tables = await tx<{ schema: string; name: string }[]>`
        select c.table_schema as schema, c.table_name as name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = any(${["payments", "invoicing", "accounting", "core"]}) and c.column_name = 'company_id'`;
      for (const t of tables) await tx`delete from ${tx(`${t.schema}.${t.name}`)} where company_id = any(${companyIds}::uuid[])`;
    });
    await sql`delete from kernel.record_snapshots where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.process_idempotency where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.outbox_dead_letter where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await seed.cleanup();
    await sql.end();
  };

  return {
    sql, seed, admin, companyId, otherCompanyId, year, today, costCenterId, partyId, servicio, methods,
    run, runStepUp, refusal, markReady, newCustomer, issuedInvoice, receive, eventsOf, entriesOfSource, linesOf, paidOf, footprint, setAccounting, cleanup,
  };
}
