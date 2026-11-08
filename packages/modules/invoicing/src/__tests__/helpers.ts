import { randomUUID } from "node:crypto";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, type Caller, type ProcessError } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { einvoicePack } from "@erp/loc-co/einvoice";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { sales } from "@erp/module-sales";
import { expect } from "vitest";
import { invoicing } from "../index";

// The invoicing harness (plan 2B Task 16): the whole sale chain with the real modules and the real posting engine on the demo chart, as the
// sales delivery tests run it. Every event is handed to its consumers as the dispatch workflow does (`drain`: origin event, the row's chain,
// one delivery per module). The company has a DIAN resolution for invoices valid all the fiscal year, a cost center VTA (the demo chart's
// 4135 and 6135 ask for one) set as the invoicing default, a ready customer, a good (IVA 5 %) and a service (IVA 19 %) with stock.

export const registry = new Registry();
export const MODULES = [kernelModule, core, accounting, inventory, costing, sales, invoicing];
loadModules(registry, MODULES);
const MODULE_IDS = ["core", "accounting", "inventory", "costing", "sales", "invoicing"];
const PROCESS_IDS = MODULE_IDS.flatMap((m) => registry.processes({ module: m })).map((p) => p.id);
const LOADED = new Set(MODULES.map((m) => m.id));

export const TECHNICAL_KEY = "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c";

const good = (sku: string, overrides: Record<string, unknown> = {}) => ({
  sku, description: `Café ${sku}`, kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, trackStock: true, ...overrides,
});
const customer = (documentNumber: string, legalName: string) => ({
  kind: ["customer"], personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@cliente.example",
});

interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }
export interface InvoiceOut { id: string; number: string | null; cufe: string | null; status: string; stage: string; dianStatus: string; origin: string; partyId: string; issueDate: string; serviceDate: string | null; dueDate: string | null; subtotal: number; taxTotal: number; total: number }

export type Harness = Awaited<ReturnType<typeof invoicingHarness>>;

/**
 * Plan 2B Task 35 (R35-13): the DIAN defaults are confirmed through the checklist, never by an input of the settings update: one `tick` run
 * for every item of the pack's list, then `confirm(true)`, each behind its own step-up code (the fixtures that need the confirmation).
 */
export async function tickAllAndConfirm(h: Pick<Harness, "runStepUp">): Promise<void> {
  await h.runStepUp("invoicing.dian_checklist.tick", { items: einvoicePack.dianChecklist.items.map((item) => ({ itemKey: item.key, ticked: true })) });
  await h.runStepUp("invoicing.dian_defaults.confirm", { confirmed: true });
}

/** The list version the confirmation stamps (for the fixtures that set the column by service SQL to reach producción quickly). */
export const DIAN_CHECKLIST_VERSION = einvoicePack.dianChecklist.version;

export async function invoicingHarness(options: { entitlements?: string[] } = {}) {
  const sql = testDb();
  registerCountryPack({ ...co, einvoice: einvoicePack });
  for (const m of [core, inventory, costing, sales, invoicing]) await syncModuleManifest(sql, m);
  const seed: SeededTenant = await seedTenant(sql, {
    companies: 2,
    // A plain member of company 0 (not its admin): the Parámetros processes refuse it even when its role holds them (Task 19 fix round 2).
    users: [{ name: "clerk", companies: [0], role: "member" }],
    entitlements: options.entitlements ?? MODULE_IDS.map((m) => `module:${m}`),
  });
  for (const company of seed.companies) {
    for (const id of PROCESS_IDS) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.adminRoleId}, ${id}) on conflict do nothing`;
    }
  }
  const companyId = seed.companies[0]!.id;
  const otherCompanyId = seed.companies[1]!.id;
  const admin: Caller = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };
  const member: Caller = { claims: seed.claimsFor(seed.users.clerk!, companyId) as JwtClaims, origin: "ui" };
  const memberRoleId = seed.companies[0]!.memberRoleId;

  const run = <T = unknown>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const runStepUp = async <T = unknown>(processId: string, input: unknown, caller: Caller = admin) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${companyId}, ${stepUpToken})`;
    return runProcess({ sql, registry }, { ...caller, stepUpToken }, processId, input) as Promise<T>;
  };
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (ProcessError & { details: unknown }) | null;

  /** Hands every undispatched outbox row of the company to each consumer of its event until nothing new is emitted; returns the failures. */
  const drain = async () => {
    const failures: { event: string; moduleId: string; message: string }[] = [];
    const failed = new Set<string>();
    for (let round = 0; round < 30; round++) {
      const rows = (await sql<OutboxRow[]>`
        select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and dispatched_at is null order by created_at, id`).filter((r) => !failed.has(r.id));
      if (rows.length === 0) return failures;
      for (const row of rows) {
        let ok = true;
        for (const consumer of consumers.for(row.event).filter((c) => LOADED.has(c.moduleId))) {
          const [done] = await sql`select 1 from kernel.outbox_deliveries where outbox_id = ${row.id} and module_id = ${consumer.moduleId}`;
          if (done) continue;
          try {
            await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
            await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, ${consumer.moduleId}) on conflict do nothing`;
          } catch (error) {
            ok = false;
            failures.push({ event: row.event, moduleId: consumer.moduleId, message: error instanceof Error ? error.message : String(error) });
          }
        }
        if (ok) await sql`update kernel.outbox set dispatched_at = now() where id = ${row.id}`;
        else failed.add(row.id);
      }
    }
    throw new Error("drain did not settle");
  };

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
  const product = async (sku: string, overrides: Record<string, unknown> = {}) => (await run<{ id: string }>(admin, "core.product.create", good(sku, overrides))).id;

  await runStepUp("accounting.chart.seed", {});
  const year = (await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${companyId}`)[0]!.year;
  await sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${companyId}`;
  const costCenterId = (await sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
  /** The company's today (Bogotá): «Emitir» dates every invoice on it (controller ruling, fix round 1). */
  const today = (await sql<{ d: string }[]>`select (now() at time zone 'America/Bogota')::date::text as d`)[0]!.d;
  const day = (month: number, d = 15) => `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const resolution = { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000999, validFrom: `${year}-01-01`, validTo: `${year}-12-31`, technicalKey: TECHNICAL_KEY };
  await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, resolution)
            values (${companyId}, 'invoice', ${resolution.prefix}, ${resolution.from}, ${sql.json(resolution as never)})`;
  await runStepUp("invoicing.settings.update", { defaultCostCenterId: costCenterId });

  const partyId = await newCustomer("860002964", "Distribuidora Andina S.A.S.");
  const cafe = await product("CAF-500");
  const servicio = await product("SRV-01", { description: "Instalación", kind: "service", trackStock: false, listPrice: 50000, ivaRate: "19" });
  const warehouseId = (await run<{ id: string }>(admin, "inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: false })).id;
  const locationId = (await run<{ id: string }>(admin, "inventory.location.create", { warehouseId, code: "A1", name: "Estante A1" })).id;
  await run(admin, "inventory.movement.post", { kind: "receipt", date: day(1, 10), warehouseId, lines: [{ productId: cafe, locationId, qty: 200, unitCost: 100 }] });
  expect(await drain()).toEqual([]);

  /** A confirmed pedido of `lines` at 20.000 each, dated `issueDate`. */
  const confirmedOrder = async (lines: { productId: string; qty: number }[], extra: { partyId?: string; issueDate?: string } = {}) => {
    const order = await run<{ id: string; number: string }>(admin, "sales.order.create", { partyId: extra.partyId ?? partyId, issueDate: extra.issueDate ?? day(3, 1), warehouseId, lines: lines.map((l) => ({ ...l, unitPrice: 20000 })) });
    await run(admin, "sales.order.confirm", { id: order.id });
    const ids = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id} order by line_no`;
    return { id: order.id, number: order.number, lineIds: ids.map((l) => l.id) };
  };
  /** Creates and ships an entrega of the pedido (`lines`: pedido line and quantity; absent, every remainder). */
  const shipDelivery = async (orderId: string, lines?: { orderLineId: string; qty: number }[], on = day(3, 10)) => {
    const delivery = await run<{ id: string; number: string; lines: { id: string; orderLineId: string; qty: number }[] }>(admin, "sales.delivery.create", { orderId, date: on, costCenterId, ...(lines ? { lines } : {}) });
    await run(admin, "sales.delivery.ship", { id: delivery.id });
    return delivery;
  };
  const setMode = (invoiceCreation: "manual" | "on_delivery" | "on_order_confirmation") => runStepUp("invoicing.settings.update", { invoiceCreation });
  const invoicesOf = (filter: { orderId?: string; deliveryId?: string }) => sql<{ id: string; number: string | null; stage: string; status: string; origin: string; total: string }[]>`
    select distinct i.id, i.number, i.stage, i.status, i.origin, i.total::text, i.seq from invoicing.invoices i join invoicing.invoice_lines l on l.invoice_id = i.id
    where i.company_id = ${companyId} and (${filter.orderId ?? null}::uuid is null or l.order_id = ${filter.orderId ?? null}::uuid)
      and (${filter.deliveryId ?? null}::uuid is null or l.delivery_id = ${filter.deliveryId ?? null}::uuid)
    order by i.seq`;
  const entriesFor = (eventId: string) => sql<{ id: string; status: string; date: string; total_debit: string; total_credit: string }[]>`
    select id, status, date::text as date, total_debit::text, total_credit::text from accounting.entries where company_id = ${companyId} and source_event_id = ${eventId}`;
  const linesOf = (entryId: string) => sql<{ code: string; debit: string; credit: string; cost_center_id: string | null }[]>`
    select a.code, l.debit::text, l.credit::text, l.cost_center_id from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entryId} order by l.line_no`;
  const issuedEvent = async (invoiceId: string) =>
    (await sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and event = 'invoicing.invoice.issued' and payload->>'invoiceId' = ${invoiceId}`);

  const cleanup = async () => {
    const companyIds = [companyId, otherCompanyId];
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const tables = await tx<{ schema: string; name: string }[]>`
        select c.table_schema as schema, c.table_name as name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = any(${["invoicing", "sales", "costing", "inventory", "accounting", "core"]}) and c.column_name = 'company_id'`;
      for (const t of tables) await tx`delete from ${tx(`${t.schema}.${t.name}`)} where company_id = any(${companyIds}::uuid[])`;
    });
    await sql`delete from kernel.record_snapshots where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.process_idempotency where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.field_permissions where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.outbox_dead_letter where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await seed.cleanup();
    await sql.end();
  };

  return {
    sql, seed, admin, member, memberRoleId, companyId, otherCompanyId, year, day, today, costCenterId, resolution, partyId, cafe, servicio, warehouseId, locationId,
    run, runStepUp, refusal, drain, markReady, newCustomer, product, confirmedOrder, shipDelivery, setMode, invoicesOf, entriesFor, linesOf, issuedEvent, cleanup,
  };
}
