import { randomUUID } from "node:crypto";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCountryPack, Registry, runProcess, runReport, syncModuleManifest, type Caller, type ProcessError } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { einvoicePack } from "@erp/loc-co/einvoice";
import { core } from "@erp/module-core";
import { inventory } from "@erp/module-inventory";
import { costing } from "../../../costing/src/index";
import { invoicing } from "../../../invoicing/src/index";
import { payments } from "../../../payments/src/index";
import { sales } from "../../../sales/src/index";
import { accounting } from "../index";

// The posting mode harness (plan 2B Task 33): the four contabiliza documentos on the real modules and the real posting engine on the demo chart
// (invoices and notes, receipts, landed costs), as the invoicing and payments harnesses run them. `drain` hands the company's events to the
// consumers of the listed modules exactly as the dispatch workflow does (origin event, the row's chain, one delivery per module, a module that
// already has its delivery is skipped). The DIAN's acceptance is simulated by setting dian_status, as the payments harness does.

export const registry = new Registry();
export const MODULES = [kernelModule, core, accounting, inventory, costing, sales, invoicing, payments];
loadModules(registry, MODULES);
const MODULE_IDS = ["core", "accounting", "inventory", "costing", "sales", "invoicing", "payments"];
const PROCESS_IDS = MODULE_IDS.flatMap((m) => registry.processes({ module: m })).map((p) => p.id);

interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }
export interface PendingRow { source_id: string; event: string; state: "queued" | "dead" | "failed"; since: Date; failure_id: string | null }

const party = (kind: string, documentNumber: string, legalName: string) => ({
  kind: [kind], personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@tercero.example",
});

export type Harness = Awaited<ReturnType<typeof postingModeHarness>>;

export async function postingModeHarness() {
  const sql = testDb();
  registerCountryPack({ ...co, einvoice: einvoicePack });
  for (const m of [core, inventory, costing, sales, invoicing, payments]) await syncModuleManifest(sql, m);
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
  /** The same user, active in company B (where accounting is never configured). */
  const otherAdmin: Caller = { claims: seed.claimsFor(seed.users.both, otherCompanyId) as JwtClaims, origin: "ui" };
  /** A plain member of company 0 whose role holds no accounting process. */
  const member: Caller = { claims: seed.claimsFor(seed.users.clerk!, companyId) as JwtClaims, origin: "ui" };

  const run = <T = unknown>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${caller.claims.active_company_id}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const runStepUp = async <T = unknown>(processId: string, input: unknown, caller: Caller = admin) => runProcess({ sql, registry }, await stepUp(caller), processId, input) as Promise<T>;
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (ProcessError & { details: unknown }) | null;

  const markReady = async (id: string) => {
    await sql`update core.parties set dian_status = 'complete' where id = ${id}`;
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'core.party', ${id}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${seed.tenantId}/${companyId}/core.party/${id}/${randomUUID()}.pdf`})`;
    }
  };

  await runStepUp("accounting.chart.seed", {});
  const year = (await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${companyId}`)[0]!.year;
  await sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${companyId}`;
  const costCenterId = (await sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
  /** The company's today (Bogotá): «Emitir» dates every invoice and note on it. */
  const today = (await sql<{ d: string }[]>`select (now() at time zone 'America/Bogota')::date::text as d`)[0]!.d;

  const resolution = { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000999, validFrom: `${year}-01-01`, validTo: `${year}-12-31`, technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c" };
  await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, resolution)
            values (${companyId}, 'invoice', ${resolution.prefix}, ${resolution.from}, ${sql.json(resolution as never)})`;
  for (const [type, prefix] of [["credit_note", "NC"], ["debit_note", "ND"]] as const) {
    await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number) values (${companyId}, ${type}, ${prefix}, 1)`;
  }
  await runStepUp("invoicing.settings.update", { defaultCostCenterId: costCenterId });

  const customerId = (await run<{ id: string }>(admin, "core.party.create", party("customer", "860002964", "Distribuidora Andina S.A.S."))).id;
  await markReady(customerId);
  const supplierId = (await run<{ id: string }>(admin, "core.party.create", party("supplier", "900123456", "Transportes del Norte S.A.S."))).id;
  await markReady(supplierId);
  const servicio = (await run<{ id: string }>(admin, "core.product.create", {
    sku: "SRV-01", description: "Instalación", kind: "service", idScheme: "999", uomCode: "94", ivaRate: "19", otherTaxes: [], listPrice: 100000, isFreeSample: false, trackStock: false,
  })).id;
  const transfer = (await run<{ id: string }>(admin, "payments.method.create", { code: "transfer", name: "Transferencia", kind: "transfer", meansCode: "47" })).id;
  const warehouseId = (await run<{ id: string }>(admin, "inventory.warehouse.create", { code: "LND", name: "Bodega LND", allowBackorders: false })).id;
  const locationId = (await run<{ id: string }>(admin, "inventory.location.create", { warehouseId, code: "A1", name: "Estante A1" })).id;

  /** Hands every company event without a delivery of `moduleIds` to their consumers, as the dispatcher does; answers the failures. */
  const drain = async (moduleIds: string[] = ["accounting"]) => {
    const failures: { event: string; moduleId: string; message: string }[] = [];
    for (let round = 0; round < 10; round++) {
      const rows = await sql<OutboxRow[]>`
        select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} order by created_at, id`;
      let ran = 0;
      for (const row of rows) {
        for (const consumer of consumers.for(row.event).filter((c) => moduleIds.includes(c.moduleId))) {
          const [done] = await sql`select 1 from kernel.outbox_deliveries where outbox_id = ${row.id} and module_id = ${consumer.moduleId}`;
          if (done) continue;
          ran += 1;
          try {
            await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
            await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, ${consumer.moduleId}) on conflict do nothing`;
          } catch (error) {
            failures.push({ event: row.event, moduleId: consumer.moduleId, message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      if (ran === 0 || failures.length > 0) return failures;
    }
    throw new Error("drain did not settle");
  };

  /** An issued invoice of the service (`qty` × 100.000 + IVA 19 %), accepted by the DIAN. */
  const issuedInvoice = async (qty = 1): Promise<{ id: string; number: string; total: number }> => {
    const draft = await run<{ id: string }>(admin, "invoicing.invoice.create", { partyId: customerId, paymentForm: "2", lines: [{ productId: servicio, qty }] });
    const issued = await run<{ id: string; number: string; total: number }>(admin, "invoicing.invoice.issue", { id: draft.id });
    await sql`update invoicing.invoices set dian_status = 'submitted' where id = ${issued.id}`;
    await sql`update invoicing.invoices set dian_status = 'accepted' where id = ${issued.id}`;
    return issued;
  };
  /** An issued credit note of one unit of the invoice's first line. */
  const issuedNote = async (invoiceId: string) => {
    const [line] = await sql<{ id: string }[]>`select id from invoicing.invoice_lines where invoice_id = ${invoiceId} order by line_no limit 1`;
    const draft = await run<{ id: string }>(admin, "invoicing.note.create", { invoiceId, kind: "credit", concept: "1", reason: "Devolución parcial del cliente", lines: [{ invoiceLineId: line!.id, qty: 1 }] });
    return run<{ id: string; number: string; total: number }>(admin, "invoicing.note.issue", { id: draft.id });
  };
  const receive = (invoiceId: string, amount: number) =>
    run<{ id: string; number: string }>(admin, "payments.payment.receive", { partyId: customerId, methodId: transfer, amount, date: today, allocations: [{ invoiceId, amount }] });
  /** A valued receipt of a stocked good, delivered to costing (and to the ledger, which posts it asynchronously by design). */
  const stockReceipt = async (sku: string) => {
    const productId = (await run<{ id: string }>(admin, "core.product.create", {
      sku, description: `Café ${sku}`, kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, trackStock: true,
    })).id;
    const { id } = await run<{ id: string }>(admin, "inventory.movement.post", { kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty: 10, unitCost: 100 }] });
    return id;
  };
  const allocate = (movementId: string, amount: number) =>
    run<{ id: string; number: string; status: string }>(admin, "costing.landed_cost.allocate", { movementId, amount, basis: "value", date: today, offsetRole: "payable", partyId: supplierId, reference: `FLETE-${randomUUID().slice(0, 6)}` });

  /** The entries whose source is the record (every rule, reversals included). */
  const entriesOf = (sourceId: string) => sql<{ id: string; status: string; total_debit: string; total_credit: string; reversal_of_id: string | null; source_event_id: string }[]>`
    select id, status, total_debit::text, total_credit::text, reversal_of_id, source_event_id from accounting.entries
    where company_id = ${companyId} and source_record_id = ${sourceId} order by posted_at, seq`;
  const eventsOf = (event: string, key: string, value: string) => sql<{ id: string; delivered: boolean }[]>`
    select o.id, exists (select 1 from kernel.outbox_deliveries d where d.outbox_id = o.id and d.module_id = 'accounting') as delivered
    from kernel.outbox o where o.company_id = ${companyId} and o.event = ${event} and o.payload->>${key} = ${value}`;
  /** `accounting.pending_postings` as `caller` (authenticated, its claims), optionally for one source. */
  const pending = async (source?: string, caller: Caller = admin): Promise<PendingRow[]> => {
    let rows: PendingRow[] = [];
    await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...caller.claims })}, true), set_config('role', 'authenticated', true)`;
      rows = source === undefined
        ? await tx<PendingRow[]>`select * from accounting.pending_postings() order by since`
        : await tx<PendingRow[]>`select * from accounting.pending_postings(${source}::uuid) order by since`;
    });
    return rows;
  };
  const count = async (table: string, where = "true") => Number((await sql.unsafe(`select count(*)::int as n from ${table} where company_id = '${companyId}' and ${where}`))[0]!.n);
  /** Sum of debits and credits of every posted entry of the company: equal when the ledger balances. */
  const ledger = async () => {
    const [row] = await sql<{ debit: string; credit: string }[]>`
      select coalesce(sum(l.debit), 0)::text as debit, coalesce(sum(l.credit), 0)::text as credit
      from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id where e.company_id = ${companyId} and e.status = 'posted'`;
    return { debit: Number(row!.debit), credit: Number(row!.credit) };
  };
  /** The trial balance of the whole fiscal year: its debit aggregate. */
  const trialDebit = async () => {
    const periods = await sql<{ id: string }[]>`
      select p.id from accounting.periods p join accounting.fiscal_years y on y.id = p.fiscal_year_id where p.company_id = ${companyId} and y.year = ${year} order by p.number`;
    const out = (await runReport({ sql, registry }, admin, "accounting.trial_balance", { from: periods[0]!.id, to: periods[periods.length - 1]!.id }, { filters: [], sort: [], page: 1, pageSize: 500 }));
    return Number(out.aggregates?.debit ?? 0);
  };
  const setMode = (mode: "inline_strict" | "asynchronous", caller: Caller = admin) =>
    runStepUp<{ id: string; mode: string; previous: string; pendingFailures: number; pendingDocuments: number }>("accounting.posting_mode.set", { mode }, caller);
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
        where c.table_schema = any(${["payments", "invoicing", "sales", "costing", "inventory", "accounting", "core"]}) and c.column_name = 'company_id'`;
      for (const t of tables) await tx`delete from ${tx(`${t.schema}.${t.name}`)} where company_id = any(${companyIds}::uuid[])`;
    });
    await sql`delete from kernel.record_snapshots where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.process_idempotency where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.field_permissions where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.company_modules where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.outbox_deliveries where outbox_id in (select id from kernel.outbox where company_id = any(${companyIds}::uuid[]))`;
    await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.outbox_dead_letter where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await seed.cleanup();
    await sql.end();
  };

  return {
    sql, seed, registry, admin, otherAdmin, member, companyId, otherCompanyId, year, today, costCenterId, customerId, supplierId, servicio, transfer, warehouseId, locationId,
    run, stepUp, runStepUp, refusal, drain, issuedInvoice, issuedNote, receive, stockReceipt, allocate, entriesOf, eventsOf, pending, count, ledger, trialDebit, setMode, setAccounting, cleanup,
  };
}
