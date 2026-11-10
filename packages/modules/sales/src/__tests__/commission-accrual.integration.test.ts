import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCountryPack, Registry, runProcess, runReport, syncModuleManifest, withClaims, type Caller } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { einvoicePack } from "@erp/loc-co/einvoice";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// invoicing and payments depend on sales: this package cannot list them (turbo refuses the cycle), so the test reaches them by path, as the
// accounting and invoicing suites reach the modules that depend on them.
import { invoicing } from "../../../invoicing/src/index";
import { payments } from "../../../payments/src/index";
import { sales } from "../index";

// Commission accrual and posting on both bases (plan 2B.2 Task 30.2, Part G design PG §5.2, §5.4; owner items 159–162; rulings RG-11,
// RG-12, RG-13; migration 0157). The whole chain runs on the real modules and the real posting engine on the demo chart: a pedido owned by a
// salesperson with a plan, invoiced by itself on confirmation (invoicing's on_order_confirmation) and issued; sales' consumer of the issued
// invoice writes the bases (Task 30.1) and emits sales.commission.due; under on_invoice sales' own consumer of that event accrues the whole
// commission; under on_collection the consumers of payments.received and payments.advance.applied accrue each collection's share:
// remaining × settled / (settled + open after), in the invoice's currency, the allocation that closes the invoice taking the remainder. Each
// commission documento (COM-n) posts Dr commission_expense (520518 employee, 523595 agent; the invoice line's cost center) / Cr
// commissions_payable (250505 employee, 233520 agent) for the payee with the due date +payment_days, so the provision is in «Cartera por
// edades» CxP. Every event is handed to its consumers as the dispatch workflow does (`drain`). The DIAN's acceptance of an invoice is
// simulated by setting dian_status, as the payments harness does.

const registry = new Registry();
const MODULES = [kernelModule, core, accounting, inventory, costing, sales, invoicing, payments];
loadModules(registry, MODULES);
const MODULE_IDS = ["core", "accounting", "inventory", "costing", "sales", "invoicing", "payments"];
const PROCESS_IDS = ["kernel", ...MODULE_IDS].flatMap((m) => registry.processes({ module: m })).map((p) => p.id);
const migration = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");

interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }
interface Commission { id: string; number: string; date: string; due_date: string; payee_party_id: string; payee_kind: string; source_kind: string; source_id: string; amount: string; status: string; stage: string; currency: string }
interface EntryLine { code: string; debit: string; credit: string; party_id: string | null; cost_center_id: string | null; due_date: string | null }

const party = (kind: string[], documentNumber: string, legalName: string, extra: Record<string, unknown> = {}) => ({
  kind, personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@tercero.example",
  ...(kind.includes("supplier") ? { supplierEmail: "compras@tercero.example" } : {}), ...extra,
});
const plusDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const num = (s: string | null | undefined) => Number(s ?? 0);

describe("commission accrual and posting (Task 30.2, migration 0157)", () => {
  const sql = testDb();
  let seed: SeededTenant;
  let companyId: string;
  let otherCompanyId: string;
  let admin: Caller;
  let today: string;
  let costCenterId: string;
  let buyerUsd: string;
  let servicio: string;
  let exportService: string;
  let warehouseId: string;
  let transfer: string;
  let transferUsd: string;
  /** Sellers: `both` (the admin) sells under the employee plan, each other user under an agent plan of their own. */
  let sellerEmployee: string;
  let sellerAgent: string;
  let sellerDropped: string;
  let payeeEmployee: string;
  let payeeAgent: string;
  let payeeDropped: string;
  let customers = 0;

  const run = <T = unknown>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const runStepUp = async <T = unknown>(processId: string, input: unknown) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${admin.claims.sub}, ${companyId}, ${stepUpToken})`;
    return runProcess({ sql, registry }, { ...admin, stepUpToken }, processId, input) as Promise<T>;
  };
  const markReady = async (id: string) => {
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'core.party', ${id}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${seed.tenantId}/${companyId}/core.party/${id}/${randomUUID()}.pdf`})`;
    }
  };
  const newParty = async (kind: string[], documentNumber: string, legalName: string, extra: Record<string, unknown> = {}) => {
    const id = (await run<{ id: string }>(admin, "core.party.create", party(kind, documentNumber, legalName, extra))).id;
    await markReady(id);
    return id;
  };
  const setAccounting = (enabled: boolean) => sql`
    insert into kernel.company_modules (company_id, module_id, enabled, enabled_at) values (${companyId}, 'accounting', ${enabled}, now())
    on conflict (company_id, module_id) do update set enabled = ${enabled}`;
  const setBasis = (commissionBasis: "on_collection" | "on_invoice") => run(admin, "sales.settings.update", { commissionBasis });

  /** Hands every company event not yet delivered to the consumers of `moduleIds`, as the dispatcher does, until nothing is left; the failures. */
  const drain = async (moduleIds: string[] = ["inventory", "costing", "sales", "invoicing", "payments", "accounting"]) => {
    const failures: { event: string; moduleId: string; message: string }[] = [];
    for (let round = 0; round < 12; round++) {
      const rows = await sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} order by created_at, id`;
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
            const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
            failures.push({ event: row.event, moduleId: consumer.moduleId, message: `${error instanceof Error ? error.message : String(error)}${cause}` });
          }
        }
      }
      if (ran === 0 || failures.length > 0) return failures;
    }
    throw new Error("drain did not settle");
  };

  /**
   * A pedido of `seller` for a customer (one line of `unitPrice`), confirmed: invoicing invoices it by itself and issues it (on_order_confirmation),
   * then the DIAN accepts it. Answers the invoice and its bases.
   */
  const sale = async (seller: string, unitPrice = 1_000_000, options: { partyId?: string; currency?: string; exchangeRate?: number; productId?: string; drainModules?: string[] } = {}) => {
    const partyId = options.partyId ?? (await newParty(["customer"], `90120${String(++customers).padStart(4, "0")}`, `Cliente Comisión ${customers} S.A.S.`));
    const order = await run<{ id: string }>(admin, "sales.order.create", {
      partyId, issueDate: today, warehouseId, lines: [{ productId: options.productId ?? servicio, qty: 1, unitPrice }],
      ...(options.currency ? { currency: options.currency, exchangeRate: options.exchangeRate } : {}),
    });
    if (seller !== admin.claims.sub) await run(admin, "sales.order.reassign", { id: order.id, ownerId: seller });
    await run(admin, "sales.order.confirm", { id: order.id });
    expect(await drain(options.drainModules)).toEqual([]);
    const [invoice] = await sql<{ id: string; number: string; stage: string; total: string; total_company: string | null }[]>`
      select distinct i.id, i.number, i.stage, i.total::text, i.total_company::text from invoicing.invoices i join invoicing.invoice_lines l on l.invoice_id = i.id
      where i.company_id = ${companyId} and l.order_id = ${order.id}`;
    expect(invoice?.stage, "the pedido's invoice was issued by itself").toBe("issued");
    await sql`update invoicing.invoices set dian_status = 'submitted' where id = ${invoice!.id}`;
    await sql`update invoicing.invoices set dian_status = 'accepted' where id = ${invoice!.id}`;
    return { orderId: order.id, partyId, invoiceId: invoice!.id, number: invoice!.number, total: num(invoice!.total) };
  };
  const receive = async (partyId: string, allocations: { invoiceId: string; amount: number; withholdings?: unknown[] }[], options: { amount?: number; methodId?: string; currency?: string; exchangeRate?: number } = {}) => {
    const held = (a: { withholdings?: unknown[] }) => (a.withholdings ?? []).reduce((s: number, w) => s + (w as { amount: number }).amount, 0);
    const amount = options.amount ?? allocations.reduce((s, a) => s + a.amount - held(a), 0);
    const receipt = await run<{ id: string; number: string }>(admin, "payments.payment.receive", {
      partyId, methodId: options.methodId ?? transfer, amount, date: today, allocations,
      ...(options.currency ? { currency: options.currency, exchangeRate: options.exchangeRate } : {}),
    });
    expect(await drain()).toEqual([]);
    return receipt;
  };
  const basesOf = (invoiceId: string) => sql<{ id: string; basis: string; commission: string; accrued: string; reversed: string; payee_kind: string }[]>`
    select id, basis, commission::text, accrued::text, reversed::text, payee_kind from sales.commission_bases where invoice_id = ${invoiceId} order by seq`;
  const commissionsOf = (sourceId: string) => sql<Commission[]>`
    select id, number, date::text, due_date::text, payee_party_id, payee_kind, source_kind, source_id, amount::text, status, stage, currency
    from sales.commissions where company_id = ${companyId} and source_id = ${sourceId} order by seq`;
  const commissionsOfInvoice = (invoiceId: string) => sql<Commission[]>`
    select distinct c.id, c.number, c.date::text, c.due_date::text, c.payee_party_id, c.payee_kind, c.source_kind, c.source_id, c.amount::text, c.status, c.stage, c.currency, c.seq
    from sales.commissions c join sales.commission_lines l on l.commission_id = c.id join sales.commission_bases b on b.id = l.base_id
    where c.company_id = ${companyId} and b.invoice_id = ${invoiceId} order by c.seq`;
  const entryOf = async (commissionId: string) => {
    const entries = await sql<{ id: string; status: string; date: string; total_debit: string; total_credit: string; source_entity: string }[]>`
      select id, status, date::text, total_debit::text, total_credit::text, source_entity from accounting.entries where company_id = ${companyId} and source_record_id = ${commissionId}`;
    if (entries.length === 0) return null;
    const lines = await sql<EntryLine[]>`
      select a.code, l.debit::text, l.credit::text, l.party_id, l.cost_center_id, l.due_date::text from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id
      where l.entry_id = ${entries[0]!.id} order by l.line_no`;
    return { ...entries[0]!, lines };
  };
  const amounts = (rows: Commission[]) => rows.map((c) => num(c.amount));
  const openItems = (partyId: string) =>
    withClaims(sql, admin.claims, (tx) => tx<{ code: string; due_date: string | null; original: string; open: string; kind: string }[]>`
      select a.code, o.due_date::text, o.original::text, o.open::text, o.kind
      from accounting.open_items(${companyId}, ${today}::date) o join accounting.accounts a on a.id = o.account_id
      where o.party_id = ${partyId} order by o.date, o.entry_id`);

  beforeAll(async () => {
    registerCountryPack({ ...co, einvoice: einvoicePack });
    for (const m of [core, inventory, costing, sales, accounting, invoicing, payments]) await syncModuleManifest(sql, m);
    seed = await seedTenant(sql, {
      companies: 2,
      users: [{ name: "agente", companies: [0], role: "member" }, { name: "sinpapeles", companies: [0], role: "member" }],
      entitlements: MODULE_IDS.map((m) => `module:${m}`),
    });
    for (const company of seed.companies) {
      for (const id of PROCESS_IDS) {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.adminRoleId}, ${id}) on conflict do nothing`;
      }
    }
    companyId = seed.companies[0]!.id;
    otherCompanyId = seed.companies[1]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };
    sellerEmployee = seed.users.both;
    sellerAgent = seed.users.agente!;
    sellerDropped = seed.users.sinpapeles!;

    await runStepUp("accounting.chart.seed", {});
    const year = (await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${companyId}`)[0]!.year;
    await sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${companyId}`;
    costCenterId = (await sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
    today = (await sql<{ d: string }[]>`select (now() at time zone 'America/Bogota')::date::text as d`)[0]!.d;
    const resolution = { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000999, validFrom: `${year}-01-01`, validTo: `${year}-12-31`, technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c" };
    await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, resolution)
              values (${companyId}, 'invoice', ${resolution.prefix}, ${resolution.from}, ${sql.json(resolution as never)})`;
    for (const [type, prefix] of [["credit_note", "NC"], ["debit_note", "ND"]] as const) {
      await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number) values (${companyId}, ${type}, ${prefix}, 1)`;
    }
    await runStepUp("invoicing.settings.update", { defaultCostCenterId: costCenterId, invoiceCreation: "on_order_confirmation" });

    // A customer of the company that is no payee (each sale makes its own buyer).
    await newParty(["customer"], "860002964", "Distribuidora Andina S.A.S.");
    buyerUsd = (await run<{ id: string }>(admin, "core.party.create", {
      kind: ["customer"], personType: "1", documentType: "50", documentNumber: "902300100", legalName: "Northwind Roasters LLC", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ",
      countryCode: "US", addressLine: "100 Main St, Seattle WA", invoiceEmail: "ap@importer.example",
    })).id;
    await markReady(buyerUsd);
    servicio = (await run<{ id: string }>(admin, "core.product.create", {
      sku: "SRV-COM", description: "Asesoría en tostión", kind: "service", idScheme: "999", uomCode: "94", ivaRate: "19", otherTaxes: [], listPrice: 1_000_000, isFreeSample: false, trackStock: false,
    })).id;
    exportService = (await run<{ id: string }>(admin, "core.product.create", {
      sku: "EXP-COM", description: "Asesoría de exportación", kind: "service", idScheme: "999", uomCode: "94", ivaRate: "0", otherTaxes: [], listPrice: 1000, isFreeSample: false, trackStock: false,
    })).id;
    warehouseId = (await run<{ id: string }>(admin, "inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: true })).id;
    transfer = (await run<{ id: string }>(admin, "payments.method.create", { code: "transfer", name: "Transferencia", kind: "transfer", meansCode: "47" })).id;
    transferUsd = (await run<{ id: string }>(admin, "payments.method.create", { code: "transfer_usd", name: "Transferencia USD", kind: "transfer", meansCode: "47", currency: "USD" })).id;

    payeeEmployee = await newParty(["employee"], "52123456", "Andrea Gómez");
    payeeAgent = await newParty(["supplier"], "900111222", "Agencia Comercial del Norte S.A.S.");
    payeeDropped = await newParty(["supplier"], "900333444", "Agente Sin Papeles S.A.S.");
    const plan = (name: string, payeePartyId: string, payeeKind: "employee" | "agent", userId: string) =>
      run(admin, "sales.commission_plan.create", { name, payeePartyId, payeeKind, defaultRatePct: 5, validFrom: `${year}-01-01`, userIds: [userId], lines: [] });
    await plan("Andrea (empleada)", payeeEmployee, "employee", sellerEmployee);
    await plan("Agencia del Norte", payeeAgent, "agent", sellerAgent);
    await plan("Agente sin papeles", payeeDropped, "agent", sellerDropped);
    expect(await drain()).toEqual([]);
  }, 300_000);

  afterAll(async () => {
    const companyIds = [companyId, otherCompanyId];
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const tables = await tx<{ schema: string; name: string }[]>`
        select c.table_schema as schema, c.table_name as name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = any(${["payments", "invoicing", "sales", "costing", "inventory", "accounting", "core"]}) and c.column_name = 'company_id'`;
      for (const t of tables) await tx`delete from ${tx(`${t.schema}.${t.name}`)} where company_id = any(${companyIds}::uuid[])`;
    });
    await sql`delete from kernel.document_links where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
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
  });

  describe("(1) on_invoice: the whole commission when the invoice is issued", () => {
    beforeAll(async () => {
      await setBasis("on_invoice");
    });
    afterAll(async () => {
      await setBasis("on_collection");
    });

    it("an employee's sale of $ 1.000.000 at 5 %: COM-n $ 50.000 dated the invoice, Dr 520518 / Cr 250505 for the payee, balanced, due +30", async () => {
      const s = await sale(sellerEmployee);
      expect((await basesOf(s.invoiceId)).map((b) => [b.basis, num(b.commission), num(b.accrued)])).toEqual([["on_invoice", 50000, 50000]]);
      const [commission, ...more] = await commissionsOf(s.invoiceId);
      expect(more).toEqual([]);
      expect(commission).toMatchObject({ date: today, due_date: plusDays(today, 30), payee_party_id: payeeEmployee, payee_kind: "employee", source_kind: "invoice", status: "posted", stage: "posted", currency: "COP" });
      expect(commission!.number).toMatch(/^COM-\d+$/);
      expect(num(commission!.amount)).toBe(50000);
      const entry = await entryOf(commission!.id);
      expect(entry).toMatchObject({ status: "posted", date: today, total_debit: "50000.0000", total_credit: "50000.0000", source_entity: "sales.commission" });
      expect(entry!.lines.map((l) => [l.code, num(l.debit), num(l.credit), l.party_id, l.cost_center_id, l.due_date])).toEqual([
        ["520518", 50000, 0, null, costCenterId, null],
        ["250505", 0, 50000, payeeEmployee, null, plusDays(today, 30)],
      ]);
      // The document trail: the invoice links to its commission.
      const [link] = await sql<{ kind: string; from_entity: string; from_id: string }[]>`
        select kind, from_entity, from_id from kernel.document_links where company_id = ${companyId} and to_entity = 'sales.commission' and to_id = ${commission!.id}`;
      expect(link).toEqual({ kind: "invoice_to_commission", from_entity: "invoicing.invoice", from_id: s.invoiceId });
      // A receipt of an on_invoice invoice accrues nothing more.
      await receive(s.partyId, [{ invoiceId: s.invoiceId, amount: s.total }]);
      expect(await commissionsOfInvoice(s.invoiceId)).toHaveLength(1);
    });

    it("an agent's sale: Dr 523595 / Cr 233520 for the agent, due +30; a redelivery of the due event writes nothing twice", async () => {
      const s = await sale(sellerAgent);
      const [commission] = await commissionsOf(s.invoiceId);
      expect(commission).toMatchObject({ payee_party_id: payeeAgent, payee_kind: "agent" });
      expect((await entryOf(commission!.id))!.lines.map((l) => [l.code, num(l.debit), num(l.credit), l.party_id])).toEqual([
        ["523595", 50000, 0, null],
        ["233520", 0, 50000, payeeAgent],
      ]);
      const [due] = await sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and event = 'sales.commission.due' and payload->>'invoiceId' = ${s.invoiceId}`;
      const consumer = consumers.for("sales.commission.due").find((c) => c.moduleId === "sales")!;
      await consumer.fn(buildConsumerContext(sql, { id: due!.id, event: due!.event, createdAt: due!.created_at, companyId, chainId: due!.chain_id }, registry), due!.payload);
      expect(await commissionsOfInvoice(s.invoiceId)).toHaveLength(1);
      expect((await basesOf(s.invoiceId)).map((b) => num(b.accrued))).toEqual([50000]);
    });
  });

  describe("(2) on_collection: each collection its share, the last one the remainder", () => {
    it("before any collection nothing is accrued; receipts of 40 % and 60 % accrue $ 20.000 and $ 30.000", async () => {
      const s = await sale(sellerEmployee);
      expect((await basesOf(s.invoiceId)).map((b) => [b.basis, num(b.commission), num(b.accrued)])).toEqual([["on_collection", 50000, 0]]);
      expect(await commissionsOfInvoice(s.invoiceId)).toEqual([]);
      const first = await receive(s.partyId, [{ invoiceId: s.invoiceId, amount: s.total * 0.4 }]);
      const second = await receive(s.partyId, [{ invoiceId: s.invoiceId, amount: s.total * 0.6 }]);
      expect(amounts(await commissionsOf(first.id))).toEqual([20000]);
      expect(amounts(await commissionsOf(second.id))).toEqual([30000]);
      const [c1] = await commissionsOf(first.id);
      expect(c1).toMatchObject({ source_kind: "receipt", date: today, due_date: plusDays(today, 30) });
      const [link] = await sql<{ kind: string; from_entity: string }[]>`select kind, from_entity from kernel.document_links where to_id = ${c1!.id}`;
      expect(link).toEqual({ kind: "receipt_to_commission", from_entity: "payments.receipt" });
      expect((await basesOf(s.invoiceId)).map((b) => num(b.accrued))).toEqual([50000]);
    });

    it("three receipts of a third each: $ 16.666,67, $ 16.666,67 and $ 16.666,66 (the last takes the remainder)", async () => {
      const s = await sale(sellerAgent);
      expect(s.total).toBe(1_190_000);
      const thirds = [396666.67, 396666.67, 396666.66];
      const receipts = [];
      for (const amount of thirds) receipts.push(await receive(s.partyId, [{ invoiceId: s.invoiceId, amount }]));
      const accrued = [];
      for (const r of receipts) accrued.push(...amounts(await commissionsOf(r.id)));
      expect(accrued).toEqual([16666.67, 16666.67, 16666.66]);
      expect(accrued.reduce((a, b) => a + b, 0)).toBeCloseTo(50000, 6);
    });
  });

  it("(3) a withholding the customer practised counts as settled: half the invoice, $ 12.500 withheld, accrues half the commission", async () => {
    const s = await sale(sellerEmployee);
    const receipt = await receive(s.partyId, [{
      invoiceId: s.invoiceId, amount: 595000, withholdings: [{ kind: "income", code: "RTEFTE_SERVICIOS_2_5", rate: 2.5, base: 500000, amount: 12500 }],
    }]);
    expect(amounts(await commissionsOf(receipt.id))).toEqual([25000]);
  });

  it("(4) a USD invoice collected at another rate accrues on the ratio in dollars: no exchange difference reaches the commission", async () => {
    const s = await sale(sellerAgent, 1000, { partyId: buyerUsd, currency: "USD", exchangeRate: 4000, productId: exportService });
    expect((await basesOf(s.invoiceId)).map((b) => num(b.commission))).toEqual([200000]);
    const receipt = await receive(buyerUsd, [{ invoiceId: s.invoiceId, amount: s.total * 0.4 }], { amount: s.total * 0.4, methodId: transferUsd, currency: "USD", exchangeRate: 4200 });
    expect(amounts(await commissionsOf(receipt.id))).toEqual([80000]);
    const [c] = await commissionsOf(receipt.id);
    expect(c!.currency).toBe("COP");
    expect((await entryOf(c!.id))!.lines.map((l) => [l.code, num(l.debit), num(l.credit)])).toEqual([["523595", 80000, 0], ["233520", 0, 80000]]);
  });

  it("(5) an advance applied to the invoice accrues like a receipt: 40 % → $ 20.000, linked from the application", async () => {
    const s = await sale(sellerEmployee);
    const advance = await receive(s.partyId, [], { amount: 476000 });
    expect(await commissionsOf(advance.id)).toEqual([]);
    const application = await run<{ id: string }>(admin, "payments.advance.apply", { partyId: s.partyId, lines: [{ receiptId: advance.id, invoiceId: s.invoiceId, amount: 476000 }] });
    expect(await drain()).toEqual([]);
    const rows = await commissionsOf(application.id);
    expect(amounts(rows)).toEqual([20000]);
    expect(rows[0]).toMatchObject({ source_kind: "advance" });
    const [link] = await sql<{ kind: string; from_entity: string }[]>`select kind, from_entity from kernel.document_links where to_id = ${rows[0]!.id}`;
    expect(link).toEqual({ kind: "receipt_to_commission", from_entity: "payments.advance_application" });
  });

  it("(6) the provision is open in accounting.open_items CxP for the payee with its due date, and in «Cartera por edades» CxP", async () => {
    const s = await sale(sellerAgent);
    const receipt = await receive(s.partyId, [{ invoiceId: s.invoiceId, amount: s.total * 0.4 }]);
    expect(amounts(await commissionsOf(receipt.id))).toEqual([20000]);
    const items = (await openItems(payeeAgent)).filter((i) => i.code === "233520");
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.kind === "document" && i.due_date === plusDays(today, 30))).toBe(true);
    const total = items.reduce((t, i) => t + num(i.open), 0);
    const accruedToAgent = (await sql<{ s: string }[]>`select coalesce(sum(amount), 0)::text as s from sales.commissions where company_id = ${companyId} and payee_party_id = ${payeeAgent}`)[0]!.s;
    expect(total).toBeCloseTo(num(accruedToAgent), 4);
    const out = (await runReport({ sql, registry }, admin, "accounting.aging", { kind: "payable", asOf: today }, { filters: [], sort: [], page: 1, pageSize: 500 })) as { rows: Record<string, unknown>[] };
    const row = out.rows.find((r) => r.party_id === payeeAgent);
    expect(row, "the agent is in the payables aging").toBeDefined();
    expect(row!.not_due).toBeCloseTo(num(accruedToAgent), 4);
  });

  it("(7) with accounting off the accrual event parks; it posts when accounting is enabled again", async () => {
    await setBasis("on_invoice");
    await setAccounting(false);
    let commission: Commission | undefined;
    try {
      const s = await sale(sellerEmployee, 1_000_000, { drainModules: ["inventory", "costing", "sales", "invoicing", "payments"] });
      [commission] = await commissionsOf(s.invoiceId);
      expect(commission).toMatchObject({ status: "posted", amount: "50000.0000" });
      expect(await entryOf(commission!.id)).toBeNull();
      const [event] = await sql<{ id: string; delivered: boolean }[]>`
        select o.id, exists (select 1 from kernel.outbox_deliveries d where d.outbox_id = o.id and d.module_id = 'accounting') as delivered
        from kernel.outbox o where o.company_id = ${companyId} and o.event = 'sales.commission.accrued' and o.payload->>'commissionId' = ${commission!.id}`;
      expect(event).toMatchObject({ delivered: false });
    } finally {
      await setAccounting(true);
      await setBasis("on_collection");
    }
    expect(await drain(["accounting"])).toEqual([]);
    expect((await entryOf(commission!.id))!.lines.map((l) => [l.code, num(l.debit), num(l.credit)])).toEqual([["520518", 50000, 0], ["250505", 0, 50000]]);
  });

  it("(8) changing commission_basis affects later invoices only", async () => {
    const before = await sale(sellerAgent);
    await setBasis("on_invoice");
    try {
      const after = await sale(sellerAgent);
      expect((await basesOf(before.invoiceId)).map((b) => b.basis)).toEqual(["on_collection"]);
      expect((await basesOf(after.invoiceId)).map((b) => b.basis)).toEqual(["on_invoice"]);
      expect(amounts(await commissionsOf(after.invoiceId))).toEqual([50000]);
      expect(await commissionsOfInvoice(before.invoiceId)).toEqual([]);
      // The earlier invoice still accrues on its collection, under the basis of its bases.
      const receipt = await receive(before.partyId, [{ invoiceId: before.invoiceId, amount: before.total }]);
      expect(amounts(await commissionsOf(receipt.id))).toEqual([50000]);
    } finally {
      await setBasis("on_collection");
    }
  });

  it("(9) a payee no longer invoice-ready: the posting is a pending posting failure (not lost) and the invoice's other consumers are unaffected", async () => {
    await sql`update kernel.attachments set removed_at = now() where company_id = ${companyId} and entity = 'core.party' and record_id = ${payeeDropped}`;
    const [ready] = await withClaims(sql, admin.claims, (tx) => tx<{ invoice_ready: boolean }[]>`select invoice_ready from core.v_party_readiness where id = ${payeeDropped}`);
    expect(ready!.invoice_ready).toBe(false);
    await setBasis("on_invoice");
    try {
      const s = await sale(sellerDropped);
      const [commission] = await commissionsOf(s.invoiceId);
      expect(commission).toMatchObject({ status: "posted", payee_party_id: payeeDropped, amount: "50000.0000" });
      expect(await entryOf(commission!.id)).toBeNull();
      const failures = await sql<{ status: string; event: string }[]>`
        select status, event from accounting.posting_failures where company_id = ${companyId} and event = 'sales.commission.accrued' and payload->>'commissionId' = ${commission!.id}`;
      expect(failures).toEqual([{ status: "pending", event: "sales.commission.accrued" }]);
      // Every consumer of the issued invoice and of the due event ran: sales recorded the invoice (record_invoiced, then the bases).
      const delivered = await sql<{ event: string; module_id: string }[]>`
        select o.event, d.module_id from kernel.outbox o join kernel.outbox_deliveries d on d.outbox_id = o.id
        where o.company_id = ${companyId} and ((o.event = 'invoicing.invoice.issued' and o.payload->>'invoiceId' = ${s.invoiceId})
           or (o.event = 'sales.commission.due' and o.payload->>'invoiceId' = ${s.invoiceId})) and d.module_id = 'sales' order by o.event`;
      expect(delivered.map((d) => d.event)).toEqual(["invoicing.invoice.issued", "sales.commission.due"]);
      expect(await sql`select 1 from kernel.outbox_dead_letter where company_id = ${companyId}`).toEqual([]);
    } finally {
      await setBasis("on_collection");
    }
  });

  describe("migration 0157", () => {
    it("brings the commission accounts, flags and mappings to a chart seeded before it, once; enabling sales no longer refuses the roles", async () => {
      const ROLLBACK = new Error("rollback");
      const seen = await sql.begin(async (tx) => {
        await tx`delete from accounting.account_role_mappings where company_id = ${companyId} and role in ('commission_expense', 'commissions_payable')`;
        await tx`set local session_replication_role = replica`;
        // Entries of the earlier cases name these rules; the replica role skips the foreign keys (the transaction rolls back).
        await tx`delete from accounting.posting_rules where company_id = ${companyId} and module = 'sales'`;
        await tx`delete from accounting.accounts a where a.company_id = ${companyId} and a.code in ('520518', '523595')`;
        await tx`set local session_replication_role = origin`;
        await tx`update accounting.accounts set requires_invoice_ready = false where company_id = ${companyId} and code in ('250505', '233520')`;
        for (let n = 0; n < 2; n++) await tx.unsafe(migration("0157_sales_commission_accounts.sql"));
        const mappings = await tx<{ role: string; dimension: string | null; code: string }[]>`
          select m.role, m.dimension, a.code from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
          where m.company_id = ${companyId} and m.role in ('commission_expense', 'commissions_payable') order by m.role, m.dimension nulls first`;
        const accounts = await tx<{ code: string; requires_party: boolean; requires_invoice_ready: boolean; requires_cost_center: boolean; allows_movement: boolean }[]>`
          select code, requires_party, requires_invoice_ready, requires_cost_center, allows_movement from accounting.accounts
          where company_id = ${companyId} and code in ('520518', '523595', '250505', '233520') order by code`;
        const rules = await tx<{ event: string; is_active: boolean }[]>`select event, is_active from accounting.posting_rules where company_id = ${companyId} and module = 'sales' order by event`;
        throw Object.assign(ROLLBACK, { rows: { mappings, accounts, rules } });
      }).catch((e: unknown) => (e === ROLLBACK ? (ROLLBACK as Error & { rows: unknown }).rows : Promise.reject(e)));
      expect(seen).toEqual({
        mappings: [
          { role: "commission_expense", dimension: null, code: "523595" },
          { role: "commission_expense", dimension: "payee_kind:agent", code: "523595" },
          { role: "commission_expense", dimension: "payee_kind:employee", code: "520518" },
          { role: "commissions_payable", dimension: null, code: "233520" },
          { role: "commissions_payable", dimension: "payee_kind:agent", code: "233520" },
          { role: "commissions_payable", dimension: "payee_kind:employee", code: "250505" },
        ],
        accounts: [
          { code: "233520", requires_party: true, requires_invoice_ready: true, requires_cost_center: false, allows_movement: true },
          { code: "250505", requires_party: true, requires_invoice_ready: true, requires_cost_center: false, allows_movement: true },
          { code: "520518", requires_party: false, requires_invoice_ready: false, requires_cost_center: true, allows_movement: true },
          { code: "523595", requires_party: false, requires_invoice_ready: false, requires_cost_center: true, allows_movement: true },
        ],
        rules: [{ event: "sales.commission.accrued", is_active: true }, { event: "sales.commission.reversed", is_active: true }],
      });
      // The pack maps every role the sales manifest declares, so Activar módulo passes its check (kernel.admin.module.enable, design §5.3).
      await expect(runStepUp("kernel.admin.module.enable", { moduleId: "sales" })).resolves.toEqual({ moduleId: "sales", enabled: true });
    });
  });
});
