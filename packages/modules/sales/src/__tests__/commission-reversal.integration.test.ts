import { randomUUID } from "node:crypto";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, withClaims, type Caller } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { einvoicePack } from "@erp/loc-co/einvoice";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// invoicing and payments depend on sales: this package cannot list them (turbo refuses the cycle), so the test reaches them by path, as
// commission-accrual.integration.test.ts does.
import { invoicing } from "../../../invoicing/src/index";
import { payments } from "../../../payments/src/index";
import { sales } from "../index";

// Commission reversals (plan 2B.2 Task 30.3, Part G design PG §5.3; ruling RG-11; Review Focus 4 and 5). The whole chain on the real
// modules and the real posting engine, as the accrual suite: a pedido owned by a salesperson with a plan, invoiced by itself on confirmation
// and issued; its commissions accrue (Task 30.2). Then:
//   - the annulment (Anular: the credit note of annulment, invoicing.note.issued with annulment, and later invoicing.invoice.annulled)
//     reverses every unpaid commission of the invoice (sales.commission.reverse: stage reversed, entry by reverseOf) and closes its bases;
//   - a partial credit note reduces the bases of the lines it names (by invoiceLineId) at the frozen rate: under on_invoice a commission
//     documento with negative lines posts the difference (source note); under on_collection only what is left to accrue shrinks;
//   - a receipt void (payments.payment.voided) and an advance unapply (payments.advance.unapplied) reverse that document's commissions whole,
//     and what they had accrued is collectable again;
//   - a paid commission is never reversed: the run answers commission_paid and raises one recommendation for the holders of the reverse.
// Every event is handed to its consumers as the dispatch workflow does (`drain`). The DIAN's acceptance of an invoice is simulated by
// setting dian_status, as the accrual suite does.

const registry = new Registry();
const MODULES = [kernelModule, core, accounting, inventory, costing, sales, invoicing, payments];
loadModules(registry, MODULES);
const MODULE_IDS = ["core", "accounting", "inventory", "costing", "sales", "invoicing", "payments"];
const PROCESS_IDS = ["kernel", ...MODULE_IDS].flatMap((m) => registry.processes({ module: m })).map((p) => p.id);

interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }
interface Commission { id: string; number: string; source_kind: string; source_id: string; amount: string; status: string; stage: string }
interface Base { id: string; invoice_line_id: string; basis: string; base: string; commission: string; accrued: string; reversed: string; status: string }

const party = (kind: string[], documentNumber: string, legalName: string) => ({
  kind, personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@tercero.example",
  ...(kind.includes("supplier") ? { supplierEmail: "compras@tercero.example" } : {}),
});
const num = (s: string | null | undefined) => Number(s ?? 0);
const cents = (n: number) => Math.round(n * 100) / 100;

describe("commission reversals (Task 30.3)", () => {
  const sql = testDb();
  let seed: SeededTenant;
  let companyId: string;
  let otherCompanyId: string;
  let admin: Caller;
  let today: string;
  let servicio: string;
  let warehouseId: string;
  let transfer: string;
  const sellers: Record<"annul" | "note" | "collect" | "void" | "advance" | "paid", string> = { annul: "", note: "", collect: "", void: "", advance: "", paid: "" };
  const payees: Record<keyof typeof sellers, string> = { annul: "", note: "", collect: "", void: "", advance: "", paid: "" };
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
  const newParty = async (kind: string[], documentNumber: string, legalName: string) => {
    const id = (await run<{ id: string }>(admin, "core.party.create", party(kind, documentNumber, legalName))).id;
    await markReady(id);
    return id;
  };
  const setBasis = (commissionBasis: "on_collection" | "on_invoice") => run(admin, "sales.settings.update", { commissionBasis });

  /** Hands every company event not yet delivered to the consumers, as the dispatcher does, until nothing is left; the failures. */
  const drain = async () => {
    const moduleIds = ["inventory", "costing", "sales", "invoicing", "payments", "accounting"];
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
  /** Hands an outbox row (already delivered) to sales' consumer again: a redelivery. */
  const redeliver = async (event: string, where: (payload: Record<string, unknown>) => boolean) => {
    const rows = (await sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and event = ${event} order by created_at`).filter((r) => where(r.payload));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const consumer = consumers.for(event).find((c) => c.moduleId === "sales")!;
    await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
  };

  /** A pedido of `seller` (one line per price), confirmed: invoiced and issued by itself, accepted by the DIAN. */
  const sale = async (seller: string, prices: number[] = [1_000_000]) => {
    const partyId = await newParty(["customer"], `90130${String(++customers).padStart(4, "0")}`, `Cliente Reversión ${customers} S.A.S.`);
    const order = await run<{ id: string }>(admin, "sales.order.create", {
      partyId, issueDate: today, warehouseId, lines: prices.map((unitPrice) => ({ productId: servicio, qty: 1, unitPrice })),
    });
    if (seller !== admin.claims.sub) await run(admin, "sales.order.reassign", { id: order.id, ownerId: seller });
    await run(admin, "sales.order.confirm", { id: order.id });
    expect(await drain()).toEqual([]);
    const [invoice] = await sql<{ id: string; number: string; stage: string; total: string }[]>`
      select distinct i.id, i.number, i.stage, i.total::text from invoicing.invoices i join invoicing.invoice_lines l on l.invoice_id = i.id
      where i.company_id = ${companyId} and l.order_id = ${order.id}`;
    expect(invoice?.stage, "the pedido's invoice was issued by itself").toBe("issued");
    await sql`update invoicing.invoices set dian_status = 'submitted' where id = ${invoice!.id}`;
    await sql`update invoicing.invoices set dian_status = 'accepted' where id = ${invoice!.id}`;
    const lines = await sql<{ id: string }[]>`select id from invoicing.invoice_lines where invoice_id = ${invoice!.id} order by line_no`;
    return { partyId, invoiceId: invoice!.id, total: num(invoice!.total), lineIds: lines.map((l) => l.id) };
  };
  const receive = async (partyId: string, allocations: { invoiceId: string; amount: number }[], amount?: number) => {
    const receipt = await run<{ id: string }>(admin, "payments.payment.receive", {
      partyId, methodId: transfer, amount: amount ?? allocations.reduce((s, a) => s + a.amount, 0), date: today, allocations,
    });
    expect(await drain()).toEqual([]);
    return receipt;
  };
  /** A partial credit note of the invoice: `amount` off one line (qty 1 at that net price). */
  const creditNote = async (invoiceId: string, invoiceLineId: string, amount: number) => {
    const note = await run<{ id: string }>(admin, "invoicing.note.create", {
      invoiceId, kind: "credit", concept: "1", reason: "Devolución parcial", lines: [{ invoiceLineId, qty: 1, unitPrice: amount }],
    });
    await run(admin, "invoicing.note.issue", { id: note.id });
    expect(await drain()).toEqual([]);
    return note.id;
  };
  const basesOf = (invoiceId: string) => sql<Base[]>`
    select id, invoice_line_id, basis, base::text, commission::text, accrued::text, reversed::text, status from sales.commission_bases where invoice_id = ${invoiceId} order by seq`;
  const commissionsOf = (sourceId: string) => sql<Commission[]>`
    select id, number, source_kind, source_id, amount::text, status, stage from sales.commissions where company_id = ${companyId} and source_id = ${sourceId} order by seq`;
  const commissionsOfInvoice = (invoiceId: string) => sql<Commission[]>`
    select distinct c.id, c.number, c.source_kind, c.source_id, c.amount::text, c.status, c.stage, c.seq
    from sales.commissions c join sales.commission_lines l on l.commission_id = c.id join sales.commission_bases b on b.id = l.base_id
    where c.company_id = ${companyId} and b.invoice_id = ${invoiceId} order by c.seq`;
  const entriesOf = async (commissionId: string) => {
    const entries = await sql<{ id: string; status: string; reversal_of_id: string | null; reversed_by_id: string | null; total_debit: string }[]>`
      select id, status, reversal_of_id, reversed_by_id, total_debit::text from accounting.entries
      where company_id = ${companyId} and (source_record_id = ${commissionId}
        or reversal_of_id in (select id from accounting.entries where company_id = ${companyId} and source_record_id = ${commissionId}))
      order by created_at, id`;
    const withLines = [];
    for (const e of entries) {
      const lines = await sql<{ code: string; debit: string; credit: string; party_id: string | null }[]>`
        select a.code, l.debit::text, l.credit::text, l.party_id from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id
        where l.entry_id = ${e.id} order by l.line_no`;
      withLines.push({ ...e, lines: lines.map((l) => [l.code, num(l.debit), num(l.credit), l.party_id]) });
    }
    return withLines;
  };
  const openPayable = async (partyId: string) =>
    (await withClaims(sql, admin.claims, (tx) => tx<{ code: string; open: string }[]>`
      select a.code, o.open::text from accounting.open_items(${companyId}, ${today}::date) o join accounting.accounts a on a.id = o.account_id
      where o.party_id = ${partyId} and a.code in ('250505', '233520')`)).reduce((s, i) => s + num(i.open), 0);
  const openRecommendations = (commissionId: string) => sql<{ id: string; reason: string; audience_process_id: string; occurrences: number }[]>`
    select id, reason, audience_process_id, occurrences from kernel.recommendations
    where company_id = ${companyId} and subject_entity = 'sales.commission' and subject_id = ${commissionId} and status = 'new'`;

  beforeAll(async () => {
    registerCountryPack({ ...co, einvoice: einvoicePack });
    for (const m of [core, inventory, costing, sales, accounting, invoicing, payments]) await syncModuleManifest(sql, m);
    const names = Object.keys(sellers) as (keyof typeof sellers)[];
    seed = await seedTenant(sql, {
      companies: 2,
      users: names.map((name) => ({ name: `rev_${name}`, companies: [0], role: "member" })),
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

    await runStepUp("accounting.chart.seed", {});
    const year = (await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${companyId}`)[0]!.year;
    await sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${companyId}`;
    const costCenterId = (await sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
    today = (await sql<{ d: string }[]>`select (now() at time zone 'America/Bogota')::date::text as d`)[0]!.d;
    const resolution = { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000999, validFrom: `${year}-01-01`, validTo: `${year}-12-31`, technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c" };
    await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, resolution)
              values (${companyId}, 'invoice', ${resolution.prefix}, ${resolution.from}, ${sql.json(resolution as never)})`;
    for (const [type, prefix] of [["credit_note", "NC"], ["debit_note", "ND"]] as const) {
      await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number) values (${companyId}, ${type}, ${prefix}, 1)`;
    }
    await runStepUp("invoicing.settings.update", { defaultCostCenterId: costCenterId, invoiceCreation: "on_order_confirmation" });
    servicio = (await run<{ id: string }>(admin, "core.product.create", {
      sku: "SRV-REV", description: "Asesoría en tostión", kind: "service", idScheme: "999", uomCode: "94", ivaRate: "19", otherTaxes: [], listPrice: 1_000_000, isFreeSample: false, trackStock: false,
    })).id;
    warehouseId = (await run<{ id: string }>(admin, "inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: true })).id;
    transfer = (await run<{ id: string }>(admin, "payments.method.create", { code: "transfer", name: "Transferencia", kind: "transfer", meansCode: "47" })).id;

    // One seller and one payee per case, so the payables aging of each payee holds only that case's commissions.
    let n = 0;
    for (const name of names) {
      sellers[name] = seed.users[`rev_${name}`]!;
      const kind = name === "annul" ? "employee" : "agent";
      payees[name] = await newParty([kind === "employee" ? "employee" : "supplier"], `9004000${String(++n).padStart(2, "0")}`, `Beneficiario ${name} S.A.S.`);
      await run(admin, "sales.commission_plan.create", { name: `Plan ${name}`, payeePartyId: payees[name], payeeKind: kind, defaultRatePct: 5, validFrom: `${year}-01-01`, userIds: [sellers[name]], lines: [] });
    }
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
    await sql`delete from kernel.recommendations where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
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

  describe("on_invoice", () => {
    beforeAll(async () => {
      await setBasis("on_invoice");
    });
    afterAll(async () => {
      await setBasis("on_collection");
    });

    it("(1) the annulment reverses COM-n: stage reversed, its entry reversed by reverseOf, the bases closed, the payee's aging empty; the later annulled event changes nothing", async () => {
      const s = await sale(sellers.annul);
      const [commission, ...more] = await commissionsOfInvoice(s.invoiceId);
      expect(more).toEqual([]);
      expect(num(commission!.amount)).toBe(50000);
      expect(await openPayable(payees.annul)).toBe(50000);

      const voided = await runStepUp<{ annulmentNoteId: string }>("invoicing.invoice.void", { id: s.invoiceId, reason: "Precio equivocado" });
      expect(await drain()).toEqual([]);

      const [after] = await commissionsOfInvoice(s.invoiceId);
      expect(after).toMatchObject({ id: commission!.id, status: "posted", stage: "reversed" });
      expect((await basesOf(s.invoiceId)).map((b) => [b.status, num(b.accrued), num(b.reversed)])).toEqual([["closed", 50000, 50000]]);
      const entries = await entriesOf(commission!.id);
      expect(entries).toHaveLength(2);
      const [accrual, reversal] = entries;
      expect(accrual!.reversed_by_id).toBe(reversal!.id);
      expect(reversal!.reversal_of_id).toBe(accrual!.id);
      expect(reversal!.lines).toEqual([["520518", 0, 50000, null], ["250505", 50000, 0, payees.annul]]);
      expect(await openPayable(payees.annul)).toBe(0);

      // The DIAN accepts the annulment note later: invoicing.invoice.annulled names the same note; nothing is reversed twice.
      const consumer = consumers.for("invoicing.invoice.annulled").find((c) => c.moduleId === "sales")!;
      await consumer.fn(
        buildConsumerContext(sql, { id: randomUUID(), event: "invoicing.invoice.annulled", createdAt: new Date(), companyId, chainId: randomUUID() }, registry),
        { invoiceId: s.invoiceId, noteId: voided.annulmentNoteId, deliveryIds: [] },
      );
      expect(await entriesOf(commission!.id)).toHaveLength(2);
      expect((await basesOf(s.invoiceId)).map((b) => num(b.reversed))).toEqual([50000]);
    });

    it("(2a) a partial credit note of 30 % on one line posts −30 % of that line's commission (a documento of source note) and leaves the other line", async () => {
      const s = await sale(sellers.note, [1_000_000, 500_000]);
      expect(amountsOf(await commissionsOfInvoice(s.invoiceId))).toEqual([75000]);
      const noteId = await creditNote(s.invoiceId, s.lineIds[0]!, 300_000);

      const [noted, ...more] = await commissionsOf(noteId);
      expect(more).toEqual([]);
      expect(noted).toMatchObject({ source_kind: "note", status: "posted", stage: "posted" });
      expect(num(noted!.amount)).toBe(-15000);
      expect((await basesOf(s.invoiceId)).map((b) => [b.invoice_line_id, num(b.base), num(b.commission), num(b.accrued), b.status])).toEqual([
        [s.lineIds[0], 700000, 35000, 35000, "open"],
        [s.lineIds[1], 500000, 25000, 25000, "open"],
      ]);
      const [entry] = await entriesOf(noted!.id);
      expect(entry!.lines).toEqual([["523595", 0, 15000, null], ["233520", 15000, 0, payees.note]]);
      expect(await openPayable(payees.note)).toBe(60000);
      // A redelivery of the note writes nothing twice.
      await redeliver("invoicing.note.issued", (p) => p.noteId === noteId);
      expect(await commissionsOf(noteId)).toHaveLength(1);
      expect((await basesOf(s.invoiceId)).map((b) => num(b.base))).toEqual([700000, 500000]);
    });
  });

  it("(2b) on_collection: a note between collections shrinks only what is left; the next collections accrue on the reduced base and the total is rate × (base − note) to the cent", async () => {
    const s = await sale(sellers.collect, [1_000_000, 500_000]);
    expect(s.total).toBe(1_785_000);
    const r1 = await receive(s.partyId, [{ invoiceId: s.invoiceId, amount: 714_000 }]);
    expect(amountsOf(await commissionsOf(r1.id))).toEqual([30000]);
    const noteId = await creditNote(s.invoiceId, s.lineIds[0]!, 300_000);
    expect(await commissionsOf(noteId)).toEqual([]);
    expect((await basesOf(s.invoiceId)).map((b) => [num(b.base), num(b.commission), num(b.accrued)])).toEqual([[700000, 35000, 20000], [500000, 25000, 10000]]);
    // Open after the note: 1.785.000 − 714.000 − 357.000 = 714.000. A third of it accrues a third of what is left of each base.
    const r2 = await receive(s.partyId, [{ invoiceId: s.invoiceId, amount: 238_000 }]);
    expect(amountsOf(await commissionsOf(r2.id))).toEqual([10000]);
    const r3 = await receive(s.partyId, [{ invoiceId: s.invoiceId, amount: 476_000 }]);
    expect(amountsOf(await commissionsOf(r3.id))).toEqual([20000]);
    const bases = await basesOf(s.invoiceId);
    expect(bases.map((b) => num(b.accrued) - num(b.reversed))).toEqual([cents(0.05 * (1_000_000 - 300_000)), cents(0.05 * 500_000)]);
    expect(await openPayable(payees.collect)).toBe(60000);
  });

  describe("receipt void", () => {
    let invoice: Awaited<ReturnType<typeof sale>>;
    let r1: { id: string };
    let r2: { id: string };

    it("(3) a receipt void reverses that receipt's commission only; what it had accrued is collectable again", async () => {
      invoice = await sale(sellers.void);
      r1 = await receive(invoice.partyId, [{ invoiceId: invoice.invoiceId, amount: 476_000 }]);
      r2 = await receive(invoice.partyId, [{ invoiceId: invoice.invoiceId, amount: 238_000 }]);
      const [c1] = await commissionsOf(r1.id);
      const [c2] = await commissionsOf(r2.id);
      expect([num(c1!.amount), num(c2!.amount)]).toEqual([20000, 10000]);

      await runStepUp("payments.payment.void", { id: r1.id, reason: "Consignación devuelta" });
      expect(await drain()).toEqual([]);

      expect((await commissionsOf(r1.id)).map((c) => c.stage)).toEqual(["reversed"]);
      expect((await commissionsOf(r2.id)).map((c) => c.stage)).toEqual(["posted"]);
      const entries = await entriesOf(c1!.id);
      expect(entries).toHaveLength(2);
      expect(entries[1]!.lines).toEqual([["523595", 0, 20000, null], ["233520", 20000, 0, payees.void]]);
      expect((await basesOf(invoice.invoiceId)).map((b) => [b.status, num(b.accrued), num(b.reversed)])).toEqual([["open", 30000, 20000]]);
      expect(await openPayable(payees.void)).toBe(10000);

      // Open again: 1.190.000 − 238.000 = 952.000; half of it accrues half of what is left (50.000 − 10.000).
      const r3 = await receive(invoice.partyId, [{ invoiceId: invoice.invoiceId, amount: 476_000 }]);
      expect(amountsOf(await commissionsOf(r3.id))).toEqual([20000]);
      const [base] = await basesOf(invoice.invoiceId);
      expect(num(base!.accrued) - num(base!.reversed)).toBe(30000);
    });

    it("(6) a redelivered payments.payment.voided reverses once", async () => {
      await redeliver("payments.payment.voided", (p) => p.paymentId === r1.id);
      const [c1] = await commissionsOf(r1.id);
      expect(await entriesOf(c1!.id)).toHaveLength(2);
      expect((await basesOf(invoice.invoiceId)).map((b) => num(b.reversed))).toEqual([20000]);
      expect((await commissionsOf(r2.id)).map((c) => c.stage)).toEqual(["posted"]);
    });
  });

  it("(4) an advance unapply reverses that application's commission; a new application accrues again", async () => {
    const s = await sale(sellers.advance);
    const advance = await receive(s.partyId, [], 476_000);
    const first = await run<{ id: string }>(admin, "payments.advance.apply", { partyId: s.partyId, lines: [{ receiptId: advance.id, invoiceId: s.invoiceId, amount: 476_000 }] });
    expect(await drain()).toEqual([]);
    const [c] = await commissionsOf(first.id);
    expect(c).toMatchObject({ source_kind: "advance", stage: "posted" });
    expect(num(c!.amount)).toBe(20000);

    await runStepUp("payments.advance.undo", { id: first.id, reason: "Aplicada a la factura equivocada" });
    expect(await drain()).toEqual([]);
    expect((await commissionsOf(first.id)).map((x) => x.stage)).toEqual(["reversed"]);
    expect(await entriesOf(c!.id)).toHaveLength(2);
    expect((await basesOf(s.invoiceId)).map((b) => [num(b.accrued), num(b.reversed)])).toEqual([[20000, 20000]]);
    expect(await openPayable(payees.advance)).toBe(0);

    const again = await run<{ id: string }>(admin, "payments.advance.apply", { partyId: s.partyId, lines: [{ receiptId: advance.id, invoiceId: s.invoiceId, amount: 476_000 }] });
    expect(await drain()).toEqual([]);
    expect(amountsOf(await commissionsOf(again.id))).toEqual([20000]);
    expect(await openPayable(payees.advance)).toBe(20000);
  });

  it("(5) a paid commission is not reversed: the run answers commission_paid and one recommendation is open for the holders of the reverse", async () => {
    await setBasis("on_invoice");
    try {
      const s = await sale(sellers.paid);
      const [commission] = await commissionsOfInvoice(s.invoiceId);
      // Fixture: nothing can pay a commission in 2B.2 (phase 3).
      await sql`update sales.commissions set stage = 'paid' where id = ${commission!.id}`;

      const out = await run<{ commissionId: string; reversed: boolean; refused?: string }>(admin, "sales.commission.reverse", { commissionId: commission!.id, reason: "Prueba" });
      expect(out).toEqual({ commissionId: commission!.id, reversed: false, refused: "commission_paid" });
      const open = await openRecommendations(commission!.id);
      expect(open).toEqual([expect.objectContaining({ reason: "commission_paid_reversal", audience_process_id: "sales.commission.reverse" })]);

      // The annulment of its invoice leaves it too, and raises no second recommendation; the event does not fail.
      await runStepUp("invoicing.invoice.void", { id: s.invoiceId, reason: "Precio equivocado" });
      expect(await drain()).toEqual([]);
      expect((await commissionsOfInvoice(s.invoiceId)).map((c) => c.stage)).toEqual(["paid"]);
      expect(await entriesOf(commission!.id)).toHaveLength(1);
      expect(await openRecommendations(commission!.id)).toHaveLength(1);
      expect(await openPayable(payees.paid)).toBe(50000);
    } finally {
      await setBasis("on_collection");
    }
  });

  it("the manifest consumes the note, the receipt void and the advance unapply, and declares the reverse and the note adjustment", () => {
    expect(Object.keys(sales.events.consumes)).toEqual(expect.arrayContaining(["invoicing.note.issued", "payments.payment.voided", "payments.advance.unapplied", "invoicing.invoice.annulled"]));
    expect(sales.events.emits).toContain("sales.commission.reversed");
    const reverse = registry.processes({ module: "sales" }).find((p) => p.id === "sales.commission.reverse")!;
    expect(reverse).toMatchObject({ kind: "update", origins: ["event", "ui"] });
    expect(registry.processes({ module: "sales" }).find((p) => p.id === "sales.commission.adjust_for_note")).toMatchObject({ origins: ["event"] });
  });
});

const amountsOf = (rows: { amount: string }[]) => rows.map((c) => Number(c.amount));
