import { randomUUID } from "node:crypto";
import { getRun } from "workflow/api";
import { InMemorySecretStore, MockEInvoiceTransport } from "@erp/infra";
import {
  buildConsumerContext, consumers, kernelModule, loadModules, registerCountryPack, Registry, registry as appRegistry, runProcess, setEInvoiceTransport, setFileStore, setSecretStore,
  syncModuleManifest, withClaims, type Caller, type ProcessError,
} from "@erp/kernel";
import { MemoryFileStore, seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { einvoicePack, saveCertificate } from "@erp/loc-co/einvoice";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { expect } from "vitest";
import { sales } from "@erp/module-sales";
// crm and payments depend on invoicing (or on a module that does): this package cannot list them (turbo refuses the cycle), so the chain
// test reaches them by path, as the accounting and costing suites reach the harnesses of other modules.
import { crm } from "../../../crm/src/index";
import { payments } from "../../../payments/src/index";
import { generateTestCertP12 } from "../../../../localization/co/src/__tests__/helpers/test-cert";
import { invoicing, softwarePinSecret } from "../index";

// The harness of the quote-to-ledger chain (plan 2B Task 23, design §8.1): every module of the chain, loaded as the app loads them, with the
// real posting engine on the demo chart and the e-invoice workflow on the MOCK DIAN (no habilitación credentials exist). Every outbox row is
// handed to its consumers as the dispatch workflow does (`drain`: origin event, the row's chain, one delivery per module); the workflow runs
// in-process (@workflow/vitest) and its steps run invoicing's processes as the consumers do (origin event, the issue's chain).
//
// The company (Café del Norte's NIT) has the demo chart, a DIAN resolution for invoices valid all the fiscal year, the DIAN software and a
// self-signed test certificate in an in-memory secret store, a cost center VTA (the demo chart's 4135 and 6135 ask for one), a ready
// customer, a coffee (IVA 5 %) with 200 units received at $ 16.000, a bodega, an embudo, and the medio de pago «Transferencia».

export const registry = new Registry();
export const MODULES = [kernelModule, core, accounting, inventory, costing, sales, crm, invoicing, payments];
loadModules(registry, MODULES);
const MODULE_IDS = ["core", "accounting", "inventory", "costing", "sales", "crm", "invoicing", "payments"];
const PROCESS_IDS = ["kernel", ...MODULE_IDS].flatMap((m) => registry.processes({ module: m })).map((p) => p.id);
const LOADED = new Set(MODULES.map((m) => m.id));

export interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }
export interface AuditRow { occurred_at: string; origin: string; process_id: string | null; entity: string; row_id: string | null; action: string; chain_id: string }

const FINAL = ["accepted", "rejected", "failed", "not_configured"];

export type ChainHarness = Awaited<ReturnType<typeof chainHarness>>;

export async function chainHarness() {
  const sql = testDb();
  registerCountryPack({ ...co, einvoice: einvoicePack });
  for (const m of [core, inventory, costing, sales, crm, invoicing, payments]) await syncModuleManifest(sql, m);
  // The workflow's steps run processes through the app's registry, as the dispatch workflow's consumers do.
  loadModules(appRegistry, MODULES);
  const seed: SeededTenant = await seedTenant(sql, { companies: 1, entitlements: MODULE_IDS.map((m) => `module:${m}`) });
  const companyId = seed.companies[0]!.id;
  for (const id of PROCESS_IDS) {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.adminRoleId}, ${id}) on conflict do nothing`;
  }
  const admin: Caller = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };

  const run = <T = unknown>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const runStepUp = async <T = unknown>(processId: string, input: unknown, caller: Caller = admin) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${companyId}, ${stepUpToken})`;
    return runProcess({ sql, registry }, { ...caller, stepUpToken }, processId, input) as Promise<T>;
  };
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (ProcessError & { details: unknown }) | null;

  /**
   * One user action (a click in the UI): the process runs as the admin on a chain of its own, which the UI's request carries, and every
   * process, event and entry it causes downstream carries it too. Answers the result and the chain id.
   */
  const act = async <T = unknown>(processId: string, input: unknown): Promise<{ result: T; chainId: string }> => {
    const chainId = randomUUID();
    return { result: await run<T>({ ...admin, chainId }, processId, input), chainId };
  };

  /**
   * Hands every undispatched outbox row of the company to each consumer of its event until nothing new is emitted; returns the failures.
   * As the dispatch workflow does (kernel events/dispatch.workflow.ts, design §5.12): a consumer whose module the company switched off
   * (kernel.company_modules.enabled = false) is not run, and its row stays undispatched with last_error = 'module_disabled' (parked) while the
   * other modules' consumers run; a later drain, once the module is on again, delivers it to what is left (the deliveries already recorded
   * are not run twice).
   */
  const drain = async () => {
    const failures: { event: string; moduleId: string; message: string }[] = [];
    const failed = new Set<string>();
    const parked = new Set<string>();
    for (let round = 0; round < 30; round++) {
      const rows = (await sql<OutboxRow[]>`
        select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and dispatched_at is null order by created_at, id`)
        .filter((r) => !failed.has(r.id) && !parked.has(r.id));
      if (rows.length === 0) return failures;
      const off = new Set((await sql<{ module_id: string }[]>`select module_id from kernel.company_modules where company_id = ${companyId} and not enabled`).map((r) => r.module_id));
      for (const row of rows) {
        let ok = true;
        let paused = false;
        for (const consumer of consumers.for(row.event).filter((c) => LOADED.has(c.moduleId))) {
          const [done] = await sql`select 1 from kernel.outbox_deliveries where outbox_id = ${row.id} and module_id = ${consumer.moduleId}`;
          if (done) continue;
          if (off.has(consumer.moduleId)) {
            paused = true;
            continue;
          }
          try {
            await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
            await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, ${consumer.moduleId}) on conflict do nothing`;
          } catch (error) {
            ok = false;
            failures.push({ event: row.event, moduleId: consumer.moduleId, message: error instanceof Error ? error.message : String(error) });
          }
        }
        if (!ok) failed.add(row.id);
        else if (paused) {
          await sql`update kernel.outbox set last_error = 'module_disabled', claimed_at = null where id = ${row.id} and dispatched_at is null`;
          parked.add(row.id);
        } else {
          await sql`update kernel.outbox set dispatched_at = now(), last_error = case when last_error = 'module_disabled' then null else last_error end where id = ${row.id}`;
        }
      }
    }
    throw new Error("drain did not settle");
  };
  /** The company's parked outbox rows (undispatched, a consumer's module switched off), oldest first. */
  const parkedRows = () => sql<OutboxRow[]>`
    select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and dispatched_at is null and last_error = 'module_disabled' order by created_at, id`;
  /** Hands one outbox row to one module's consumer again (a redelivery). */
  const redeliver = async (row: OutboxRow, moduleId: string) => {
    const consumer = consumers.for(row.event).find((c) => c.moduleId === moduleId)!;
    await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
  };

  const markReady = async (id: string) => {
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'core.party', ${id}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${seed.tenantId}/${companyId}/core.party/${id}/${randomUUID()}.pdf`})`;
    }
  };

  // The ledger: the demo chart, the ledger open from January, the cost center the sales accounts ask for.
  await runStepUp("accounting.chart.seed", {});
  const year = (await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${companyId}`)[0]!.year;
  await sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${companyId}`;
  const costCenterId = (await sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
  /** The company's today (Bogotá): every document of the chain is dated on it. */
  const today = (await sql<{ d: string }[]>`select (now() at time zone 'America/Bogota')::date::text as d`)[0]!.d;
  const plusDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  // Invoicing: the DIAN resolution, the issuer and its software, the certificate and the software PIN, the mock DIAN, the file store.
  await sql`update kernel.companies set tax_id = '900373115' where id = ${companyId}`;
  const resolution = { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000999, validFrom: `${year}-01-01`, validTo: `${year}-12-31`, technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c" };
  await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, resolution)
            values (${companyId}, 'invoice', ${resolution.prefix}, ${resolution.from}, ${sql.json(resolution as never)})`;
  // The notes' own numbering (a plain sequence: the DIAN authorizes no range for notes).
  for (const [type, prefix] of [["credit_note", "NC"], ["debit_note", "ND"]] as const) {
    await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number) values (${companyId}, ${type}, ${prefix}, 1)`;
  }
  await runStepUp("invoicing.settings.update", {
    defaultCostCenterId: costCenterId, softwareId: "56f2ae4e-9812-4fad-9255-08fcfcd5ccb0", softwareProviderTaxId: "900373115",
    issuerTaxResponsibilities: ["O-13"], issuerDepartmentCode: "11", issuerMunicipalityCode: "11001",
  });
  const secrets = new InMemorySecretStore();
  const { buffer, password } = generateTestCertP12();
  await saveCertificate(secrets, companyId, buffer, password);
  await secrets.set(softwarePinSecret(companyId), "75315");
  setSecretStore(secrets);
  setEInvoiceTransport(new MockEInvoiceTransport({ namespace: `t23-${process.pid}-${randomUUID()}`, pendingPolls: 1 }));
  setFileStore(new MemoryFileStore());

  // The customer, the coffee and its stock, the embudo, the medio de pago.
  const partyId = (await run<{ id: string }>(admin, "core.party.create", {
    kind: ["customer"], personType: "1", documentType: "31", documentNumber: "860002964", legalName: "Distribuidora Andina S.A.S.", taxResponsibilities: ["O-13"], taxScheme: "01",
    countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@cliente.example",
  })).id;
  await markReady(partyId);
  const cafe = (await run<{ id: string }>(admin, "core.product.create", {
    sku: "CAF-500", description: "Café de origen 500 g", kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, trackStock: true,
  })).id;
  const warehouseId = (await run<{ id: string }>(admin, "inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: false })).id;
  const locationId = (await run<{ id: string }>(admin, "inventory.location.create", { warehouseId, code: "A1", name: "Estante A1" })).id;
  await run(admin, "inventory.movement.post", { kind: "receipt", date: `${year}-01-10`, warehouseId, lines: [{ productId: cafe, locationId, qty: 200, unitCost: 16000 }] });
  expect(await drain()).toEqual([]);
  const pipelineId = (await run<{ id: string }>(admin, "crm.pipeline.create", {
    code: "VENTAS", name: "Embudo de ventas",
    stages: [{ name: "Nuevo", probability: 10, kind: "open" }, { name: "Propuesta", probability: 60, kind: "open" }, { name: "Ganada", probability: 100, kind: "won" }, { name: "Perdida", probability: 0, kind: "lost" }],
  })).id;
  const transferId = (await run<{ id: string }>(admin, "payments.method.create", { code: "transfer", name: "Transferencia", kind: "transfer", meansCode: "47" })).id;

  /**
   * Waits until the DIAN submission of the invoice (or, with `{ noteId }`, of that note) reaches a final status, waking the workflow's backoff
   * sleeps as they come.
   */
  const settleDian = async (target: string | { noteId: string }, statuses: string[] = FINAL) => {
    const deadline = Date.now() + 45_000;
    for (;;) {
      const [s] = typeof target === "string"
        ? await sql<{ status: string; run_id: string | null }[]>`select status, run_id from invoicing.einvoice_submissions where invoice_id = ${target} and note_id is null`
        : await sql<{ status: string; run_id: string | null }[]>`select status, run_id from invoicing.einvoice_submissions where note_id = ${target.noteId}`;
      if (s && statuses.includes(s.status)) {
        // The PDF is the run's last step, after the verdict: the run's end is waited for.
        if (s.run_id) await getRun(s.run_id).returnValue.catch(() => undefined);
        return s.status;
      }
      if (Date.now() > deadline) throw new Error(`submission of ${JSON.stringify(target)} did not settle: ${JSON.stringify(s)}`);
      if (s?.run_id) await getRun(s.run_id).wakeUp().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /** Every page of kernel.audit.consult (the audit viewer's own process, admin only) for `filters`, oldest first. */
  const audit = async (filters: { field: string; op: "eq"; value: string }[]): Promise<AuditRow[]> => {
    const rows: AuditRow[] = [];
    for (let page = 1; ; page++) {
      const out = await run<{ rows: AuditRow[]; total: number }>(admin, "kernel.audit.consult", { filters, sort: [{ field: "occurred_at", dir: "asc" }], page, pageSize: 100 });
      rows.push(...out.rows);
      if (rows.length >= out.total || out.rows.length === 0) return rows;
    }
  };
  /**
   * «¿Qué pasó cuando se confirmó el pedido N?», answered from the audit by chain id: the audit entry of the run of `processId` on the record
   * gives its causal chain; every entry of that chain is what that action caused, in this module and in every consumer downstream.
   */
  const whatHappened = async (processId: string, rowId: string) => {
    const runs = await audit([{ field: "process_id", op: "eq", value: processId }, { field: "row_id", op: "eq", value: rowId }]);
    const chains = [...new Set(runs.map((r) => r.chain_id))];
    expect(chains).toHaveLength(1);
    return { chainId: chains[0]!, entries: await audit([{ field: "chain_id", op: "eq", value: chains[0]! }]) };
  };

  const outboxOf = (chainIds: string[]) => sql<OutboxRow[]>`
    select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and chain_id = any(${chainIds}::uuid[]) order by created_at, id`;
  const outboxSince = (since: Date) => sql<OutboxRow[]>`
    select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and created_at >= ${since} order by created_at, id`;
  const auditChainsSince = async (since: Date) =>
    (await sql<{ chain_id: string }[]>`select distinct chain_id from kernel.audit_log where company_id = ${companyId} and occurred_at >= ${since}`).map((r) => r.chain_id);
  /** The entries of a source document (its record), with their journal and chain. */
  const entriesOf = (sourceId: string) => sql<{ id: string; status: string; date: string; journal: string; chain_id: string; total_debit: string; total_credit: string; source_entity: string }[]>`
    select e.id, e.status, e.date::text as date, j.code as journal, e.chain_id, e.total_debit::text, e.total_credit::text, e.source_entity
    from accounting.entries e join accounting.journals j on j.id = e.journal_id where e.company_id = ${companyId} and e.source_record_id = ${sourceId} order by e.posted_at, e.seq`;
  const linesOf = (entryId: string) => sql<{ code: string; debit: string; credit: string }[]>`
    select a.code, l.debit::text, l.credit::text from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entryId} order by l.line_no`;
  /** The trial balance of the company: Σ debits and Σ credits of every posted line, and the entries that do not balance. */
  const trialBalance = async () => {
    const [sum] = await sql<{ debit: string; credit: string }[]>`
      select coalesce(sum(l.debit), 0)::text as debit, coalesce(sum(l.credit), 0)::text as credit
      from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id where e.company_id = ${companyId} and e.status in ('posted', 'reversed')`;
    const unbalanced = await sql`select id from accounting.entries where company_id = ${companyId} and total_debit <> total_credit`;
    return { debit: Number(sum!.debit), credit: Number(sum!.credit), unbalanced: unbalanced.length };
  };
  /** The customer's balance on an account of the demo chart (posted lines). */
  const partyBalance = async (code: string) => {
    const [row] = await sql<{ balance: string | null }[]>`
      select sum(l.debit - l.credit)::text as balance from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
      where e.company_id = ${companyId} and e.status in ('posted', 'reversed') and a.code = ${code} and l.party_id = ${partyId}`;
    return Number(row?.balance ?? 0);
  };
  const stock = async () => {
    const [row] = await sql<{ on_hand: string | null; reserved: string | null }[]>`
      select sum(on_hand)::text as on_hand, sum(reserved)::text as reserved from inventory.v_stock where product_id = ${cafe} and warehouse_id = ${warehouseId}`;
    return { onHand: Number(row?.on_hand ?? 0), reserved: Number(row?.reserved ?? 0) };
  };
  const costLayer = async () => {
    const [row] = await sql<{ qty: string; value: string }[]>`select qty::text, value::text from costing.cost_layers where company_id = ${companyId} and product_id = ${cafe} and warehouse_id = ${warehouseId}`;
    return { qty: Number(row!.qty), value: Number(row!.value) };
  };
  /** The customer's credit exposure (sales.credit_exposure as the order's confirm reads it): firm pedidos not invoiced + invoices still owed. */
  const creditExposure = async () =>
    Number((await withClaims(sql, admin.claims, (tx) => tx<{ exposure: string }[]>`select exposure::text from sales.credit_exposure(${partyId}::uuid, null::uuid)`))[0]!.exposure);
  /** accounting.open_items of the customer as the admin (the aging report reads it): its receivable items still open. */
  const openItems = async () =>
    (await withClaims(sql, admin.claims, (tx) => tx<{ entry_id: string | null; code: string; open: string; kind: string }[]>`
      select o.entry_id, a.code, o.open::text, o.kind from accounting.open_items(${companyId}, ${today}::date) o join accounting.accounts a on a.id = o.account_id
      where o.party_id = ${partyId} and o.open <> 0`)).map((r) => ({ ...r, open: Number(r.open) }));

  const cleanup = async () => {
    setEInvoiceTransport(undefined);
    setSecretStore(undefined);
    setFileStore(undefined);
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const tables = await tx<{ schema: string; name: string }[]>`
        select c.table_schema as schema, c.table_name as name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = any(${["payments", "invoicing", "crm", "sales", "costing", "inventory", "accounting", "core"]}) and c.column_name = 'company_id'`;
      for (const t of tables) await tx`delete from ${tx(`${t.schema}.${t.name}`)} where company_id = ${companyId}`;
    });
    await sql`delete from kernel.record_snapshots where company_id = ${companyId}`.catch(() => undefined);
    await sql`delete from kernel.process_idempotency where company_id = ${companyId}`.catch(() => undefined);
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await sql`delete from kernel.outbox_dead_letter where company_id = ${companyId}`.catch(() => undefined);
    await seed.cleanup();
    await sql.end();
  };

  return {
    sql, admin, companyId, year, today, plusDays, costCenterId, partyId, cafe, warehouseId, locationId, pipelineId, transferId, resolution,
    run, runStepUp, refusal, act, drain, parkedRows, redeliver, markReady, settleDian, audit, whatHappened, outboxOf, outboxSince, auditChainsSince, entriesOf, linesOf, trialBalance,
    partyBalance, stock, costLayer, creditExposure, openItems, cleanup,
  };
}
