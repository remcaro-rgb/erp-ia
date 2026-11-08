import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildConsumerContext, defineEntity, defineModule, exportRows, kernelModule, loadModules, planExport, registerCountryPack, Registry, runProcess, syncModuleManifest, SYSTEM_USER_ID, type Caller, type ProcessError } from "@erp/kernel";
import { needStub, seedTenant, testDb, withClaims, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { core } from "@erp/module-core";
import { inventory } from "@erp/module-inventory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../../../kernel/src/db/client";
import { sales } from "../index";

// Order owner isolation (plan 2B Task 39, owner item 29 of 2026-11-06, design §6 and §22.28, migration 0139). A salesperson sees, opens,
// changes, confirms, cancels and delivers only the pedidos they own; whoever may run sales.order.reassign (the «all orders» permission; a
// company admin always may) sees every pedido of the company, and a pedido without owner is seen only by them. A pedido converted from a
// cotización belongs to the cotización's owner (the converter when it has none); a converter who cannot see the result gets a trimmed
// answer. sales.order.reassign moves a pedido to another member, audited. The entregas stay readable (R39-8) and show the pedido's owner
// only to who can read the pedido. Event consumers run as the system user (they read every pedido); a forged system claim through
// PostgREST does not. The backfill and the grant of 0139 are re-run against seeded rows inside a rolled-back transaction.

const registry = new Registry();
// crm depends on sales: a stand-in that declares only the entity a pedido from a cotización links from (as order.integration.test.ts).
const crmQuoteStub = defineModule({
  id: "crm", version: "0", dependsOn: ["core", "sales"], processes: [], features: [], navigation: [], events: { emits: [], consumes: {} },
  entities: [defineEntity({
    entityType: "documento", id: "crm.quote", module: "crm", schema: "crm", table: "quotes", label: "entity.crm.quote", displayField: "number",
    defaultSort: { field: "number", dir: "asc" }, fields: [{ name: "number", type: "text", label: "field.crm.quote.number" }],
  })],
});
loadModules(registry, [kernelModule, core, inventory, needStub("costing"), sales, crmQuoteStub]);
const PROCESS_IDS = ["kernel", "core", "inventory", "sales"].flatMap((m) => registry.processes({ module: m })).map((p) => p.id);
const REASSIGN = "sales.order.reassign";

/** The part of 0139 between `-- <name>: begin` and `-- <name>: end` (the backfill and the grant are re-run by the tests). */
const section = (name: string) => {
  const migration = readFileSync(new URL("../../../../../supabase/migrations/0139_sales_order_owner_isolation.sql", import.meta.url), "utf8");
  const start = migration.indexOf(`-- ${name}: begin`);
  const end = migration.indexOf(`-- ${name}: end`);
  if (start < 0 || end < 0) throw new Error(`0139 has no ${name} section`);
  return migration.slice(start, end);
};

const customer = (documentNumber: string, legalName: string) => ({
  kind: ["customer"], personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@cliente.example",
});

interface OrderOut { id: string; number: string | null; status: string; stage: string; total?: number; ownerId?: string; visible?: boolean }

describe("order owner isolation (Task 39, migration 0139)", () => {
  const sql = testDb();
  let seed: SeededTenant;
  let companyId: string;
  let otherCompanyId: string;
  let admin: Caller;
  /** Salespeople A and B: every pedido process but sales.order.reassign, the entrega's create and consult, the grid, the trail, Inicio. */
  let a: Caller;
  let b: Caller;
  /** The sales manager: what a salesperson has, plus sales.order.reassign and crm.opportunity.reassign. */
  let gerente: Caller;
  /** The warehouse: the entregas, and sales.order.reassign as 0139 grants it to a role that creates entregas (R39-7). */
  let bodega: Caller;
  /** A crm manager: sees every cotización (crm.opportunity.reassign) and converts it, but does not hold sales.order.reassign (R39-4). */
  let jefeCrm: Caller;
  /** A credit approver: approves and rejects pedidos (sales.order.approve / reject) without sales.order.reassign (review I-1, 0140). */
  let aprobador: Caller;
  let jefeCrmRole: string;
  let userA: string;
  let userB: string;
  let foreignUser: string;
  let partyId: string;
  let cafe: string;
  let warehouseId: string;

  const run = <T = unknown>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (ProcessError & { details: unknown }) | null;
  const create = (caller: Caller, input: Record<string, unknown> = {}) =>
    run<OrderOut>(caller, "sales.order.create", { partyId, issueDate: "2026-11-05", warehouseId, lines: [{ productId: cafe, qty: 1 }], ...input });
  const ownerOf = async (id: string) => (await sql<{ owner_id: string | null; owner_source: string }[]>`select owner_id, owner_source from sales.orders where id = ${id}`)[0]!;
  const visibleIds = async (caller: Caller, ids: string[]) =>
    (await withClaims(sql, caller.claims, (tx) => tx<{ id: string }[]>`select id from sales.v_orders where id = any(${ids}::uuid[]) order by id`)).map((r) => r.id);
  const markReady = async (id: string) => {
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'core.party', ${id}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${seed.tenantId}/${companyId}/core.party/${id}/${randomUUID()}.pdf`})`;
    }
  };
  let fixtureSeq = 700000 + Math.floor(Math.random() * 1000) * 100;
  /** An accepted cotización owned by `ownerId` (a crm fixture written with the triggers off, as order.integration.test.ts does). */
  const acceptedQuote = async (ownerId: string | null) => {
    const quoteId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into crm.quotes (id, seq, company_id, number, party_id, owner_id, issue_date, valid_until, stage, accepted_at, currency, exchange_rate, status, requires_approval, posts)
        values (${quoteId}, ${fixtureSeq++}, ${companyId}, ${`COT-${Math.floor(Math.random() * 1e6)}`}, ${partyId}, ${ownerId}, '2026-11-01', '2026-12-01', 'accepted', now(), 'COP', 1, 'saved', false, false)`;
      await tx`insert into crm.quote_lines (id, seq, company_id, quote_id, line_no, product_id, qty, unit_price, price_list_id, discount_pct)
        values (${randomUUID()}, ${fixtureSeq++}, ${companyId}, ${quoteId}, 1, ${cafe}, 2, 28000, null, 0)`;
    });
    return quoteId;
  };
  const grant = async (roleId: string, ids: string[]) => {
    for (const id of ids) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, ${id}) on conflict do nothing`;
  };
  const role = async (name: string) => (await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, ${name}, false) returning id`)[0]!.id;
  const asUser = (user: string, roleId: string): Caller => ({ claims: { ...seed.claimsFor(user, companyId), role_ids: [roleId] } as JwtClaims, origin: "ui" });

  beforeAll(async () => {
    registerCountryPack(co);
    await syncModuleManifest(sql, core);
    await syncModuleManifest(sql, inventory);
    await syncModuleManifest(sql, sales);
    seed = await seedTenant(sql, {
      companies: 2,
      users: [
        { name: "vendedorA", companies: [0], role: "member" },
        { name: "vendedorB", companies: [0], role: "member" },
        { name: "gerente", companies: [0], role: "member" },
        { name: "bodega", companies: [0], role: "member" },
        { name: "jefeCrm", companies: [0], role: "member" },
        { name: "aprobador", companies: [0], role: "member" },
        { name: "ajeno", companies: [1], role: "member" },
      ],
      entitlements: ["module:core", "module:inventory", "module:sales"],
    });
    companyId = seed.companies[0]!.id;
    otherCompanyId = seed.companies[1]!.id;
    for (const id of PROCESS_IDS) await grant(seed.companies[0]!.adminRoleId, [id]);
    admin = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };
    userA = seed.users.vendedorA!;
    userB = seed.users.vendedorB!;
    foreignUser = seed.users.ajeno!;

    // A salesperson never approves their own pedido (as crm's helpers): approve and reject are the approver's.
    const approvals = new Set([REASSIGN, "sales.order.approve", "sales.order.reject"]);
    const orderProcesses = PROCESS_IDS.filter((p) => (p.startsWith("sales.order.") || p.startsWith("sales.order_line.")) && !approvals.has(p));
    const reading = ["kernel.data.query", "kernel.home.kpis", "kernel.document_link.trail", "sales.delivery.create", "sales.delivery.consult", "sales.delivery_line.consult"];
    const salesRole = await role("vendedor");
    await grant(salesRole, [...orderProcesses, ...reading]);
    const managerRole = await role("gerente_comercial");
    // As in practice (owner item 96): the manager also sees every cotización.
    await grant(managerRole, [...orderProcesses, ...reading, REASSIGN, "crm.opportunity.reassign"]);
    const warehouseRole = await role("bodega");
    await grant(warehouseRole, [...PROCESS_IDS.filter((p) => p.startsWith("sales.delivery")), "sales.order.consult", "kernel.data.query", "kernel.document_link.trail", REASSIGN]);
    const crmRole = await role("jefe_crm");
    jefeCrmRole = crmRole;
    await grant(crmRole, ["crm.opportunity.reassign", "sales.order.from_quote", "sales.order.consult"]);
    const approverRole = await role("aprobador");
    await grant(approverRole, ["sales.order.approve", "sales.order.reject", "sales.order.consult", "sales.order_line.consult"]);
    for (const [user, r] of [[userA, salesRole], [userB, salesRole], [seed.users.gerente!, managerRole], [seed.users.bodega!, warehouseRole], [seed.users.jefeCrm!, crmRole], [seed.users.aprobador!, approverRole]] as const) {
      await seed.holdRoles(user, companyId, [r]);
    }
    a = asUser(userA, salesRole);
    b = asUser(userB, salesRole);
    gerente = asUser(seed.users.gerente!, managerRole);
    bodega = asUser(seed.users.bodega!, warehouseRole);
    jefeCrm = asUser(seed.users.jefeCrm!, crmRole);
    aprobador = asUser(seed.users.aprobador!, approverRole);

    partyId = (await run<{ id: string }>(admin, "core.party.create", customer("860002964", "Distribuidora Andina S.A.S."))).id;
    await markReady(partyId);
    cafe = (await run<{ id: string }>(admin, "core.product.create", {
      sku: "CAF-500", description: "Café 500 g", kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, standardCost: 16200, trackStock: true,
    })).id;
    warehouseId = (await run<{ id: string }>(admin, "inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: false })).id;
  });

  afterAll(async () => {
    const companyIds = [companyId, otherCompanyId];
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of ["sales.delivery_lines", "sales.deliveries", "sales.order_lines", "sales.orders", "sales.document_numbers", "sales.customer_terms", "sales.settings", "crm.quote_lines", "crm.quotes"]) {
        await tx`delete from ${tx(table)} where company_id = any(${companyIds}::uuid[])`;
      }
      for (const table of ["reservations", "stock_levels", "movement_lines", "movements", "movement_numbers", "locations", "warehouses"]) {
        await tx`delete from ${tx(`inventory.${table}`)} where company_id = any(${companyIds}::uuid[])`;
      }
      for (const table of ["price_list_items", "price_lists", "party_contacts", "products", "product_categories", "parties", "document_sequences", "entity_sequences"]) {
        await tx`delete from ${tx(`core.${table}`)} where company_id = any(${companyIds}::uuid[])`;
      }
    });
    await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
    await seed.cleanup();
    await sql.end();
  });

  it("a direct pedido belongs to its creator (owner_source direct) and its salesperson sees only their own", async () => {
    const mine = await create(a);
    const theirs = await create(b);
    expect(await ownerOf(mine.id)).toEqual({ owner_id: userA, owner_source: "direct" });
    expect(await ownerOf(theirs.id)).toEqual({ owner_id: userB, owner_source: "direct" });
    expect(await visibleIds(a, [mine.id, theirs.id])).toEqual([mine.id]);
    expect(await visibleIds(b, [mine.id, theirs.id])).toEqual([theirs.id]);
    expect(await visibleIds(gerente, [mine.id, theirs.id])).toEqual([mine.id, theirs.id].sort());
    expect(await visibleIds(admin, [mine.id, theirs.id])).toEqual([mine.id, theirs.id].sort());
    // The lines follow their pedido.
    const lines = (caller: Caller) => withClaims(sql, caller.claims, (tx) => tx<{ order_id: string }[]>`select order_id from sales.v_order_lines where order_id = any(${[mine.id, theirs.id]}::uuid[])`);
    expect((await lines(a)).map((l) => l.order_id)).toEqual([mine.id]);
    expect(new Set((await lines(gerente)).map((l) => l.order_id))).toEqual(new Set([mine.id, theirs.id]));
  });

  it("A cannot list, search, open, update, confirm, cancel or deliver B's pedido: each is not found (R39-2, R39-11)", async () => {
    const mine = await create(a);
    const theirs = await create(b);
    const listed = await run<{ rows: { id: string }[] }>(a, "kernel.data.query", { entity: "sales.order", limit: 50 });
    expect(listed.rows.map((r) => r.id)).toContain(mine.id);
    expect(listed.rows.map((r) => r.id)).not.toContain(theirs.id);
    const searched = await run<{ total: number }>(a, "kernel.data.query", { entity: "sales.order", search: theirs.number! });
    expect(searched.total).toBe(0);
    expect((await run<{ total: number }>(gerente, "kernel.data.query", { entity: "sales.order", search: theirs.number! })).total).toBe(1);
    expect((await refusal(run(a, "sales.order.consult", { id: theirs.id })))?.code).toBe("not_found");
    const [line] = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${theirs.id}`;
    expect((await refusal(run(a, "sales.order_line.consult", { id: line!.id })))?.code).toBe("not_found");
    expect((await refusal(run(a, "sales.order.update", { id: theirs.id, notes: "mío" })))?.code).toBe("not_found");
    expect((await refusal(run(a, "sales.order.confirm", { id: theirs.id })))?.code).toBe("not_found");
    expect((await refusal(run(a, "sales.order.cancel", { id: theirs.id, reason: "no" })))?.code).toBe("not_found");
    await run(b, "sales.order.confirm", { id: theirs.id });
    expect((await refusal(run(a, "sales.delivery.create", { orderId: theirs.id })))?.code).toBe("not_found");
    // The owner and the holder still do.
    expect(await run<{ id: string }>(b, "sales.order.consult", { id: theirs.id })).toMatchObject({ id: theirs.id, owner_id: userB });
    expect(await run<{ id: string }>(gerente, "sales.order.consult", { id: theirs.id })).toMatchObject({ id: theirs.id });
  });

  it("the invoicing view of the pedido lines shows A nothing of B's pedido (an invoice of it is not found, R39-11)", async () => {
    const theirs = await create(b);
    await run(b, "sales.order.confirm", { id: theirs.id });
    const read = (caller: Caller) => withClaims(sql, caller.claims, (tx) => tx`select id from sales.v_invoice_order_lines where order_id = ${theirs.id}`);
    expect(await read(a)).toHaveLength(0);
    expect(await read(gerente)).toHaveLength(1);
  });

  it("Inicio counts only the caller's pedidos (sales.open_orders, R39-11)", async () => {
    const kpi = async (caller: Caller) => {
      const out = await run<{ kpis: { id: string; value: number }[] }>(caller, "kernel.home.kpis", { module: "sales" });
      return out.kpis.find((k) => k.id === "sales.open_orders")?.value;
    };
    const count = async (owner: string | null) =>
      Number((await sql<{ n: string }[]>`select count(*)::text as n from sales.orders where company_id = ${companyId} and status <> 'voided'
        and stage = any(${["open", "confirmed", "partially_delivered"]}::text[]) and (${owner}::uuid is null or owner_id = ${owner}::uuid)`)[0]!.n);
    await create(a);
    expect(await kpi(a)).toBe(await count(userA));
    expect(await kpi(b)).toBe(await count(userB));
    expect(await kpi(gerente)).toBe(await count(null));
  });

  it("a pedido without owner is visible only to who may run sales.order.reassign (R39-2, owner item 97)", async () => {
    const order = await create(admin);
    await sql`update sales.orders set owner_id = null where id = ${order.id}`;
    expect(await visibleIds(a, [order.id])).toEqual([]);
    expect(await visibleIds(gerente, [order.id])).toEqual([order.id]);
    expect(await visibleIds(admin, [order.id])).toEqual([order.id]);
  });

  it("the entregas stay readable; their order_owner_id is the pedido's owner only for who reads the pedido; the trail counts it hidden (R39-8, R39-9)", async () => {
    const theirs = await create(b);
    await run(b, "sales.order.confirm", { id: theirs.id });
    const delivery = await run<{ id: string }>(bodega, "sales.delivery.create", { orderId: theirs.id });
    const ownerSeen = async (caller: Caller) =>
      (await withClaims(sql, caller.claims, (tx) => tx<{ id: string; order_owner_id: string | null }[]>`select id, order_owner_id from sales.v_deliveries where id = ${delivery.id}`))[0];
    expect(await ownerSeen(a)).toEqual({ id: delivery.id, order_owner_id: null });
    expect(await ownerSeen(bodega)).toEqual({ id: delivery.id, order_owner_id: userB });
    expect(await ownerSeen(b)).toEqual({ id: delivery.id, order_owner_id: userB });
    // The published owners view: masked like v_orders and bound by the same rule.
    const owners = (caller: Caller) => withClaims(sql, caller.claims, (tx) => tx<{ order_id: string; owner_id: string | null }[]>`select order_id, owner_id from sales.v_order_owners where order_id = ${theirs.id}`);
    expect(await owners(a)).toEqual([]);
    expect(await owners(bodega)).toEqual([{ order_id: theirs.id, owner_id: userB }]);

    const trail = (caller: Caller) => run<{ nodes: { entity: string; id: string }[]; hidden: number }>(caller, "kernel.document_link.trail", { entity: "sales.delivery", id: delivery.id });
    const forA = await trail(a);
    expect(forA.nodes.map((n) => n.id)).not.toContain(theirs.id);
    // Exactly one hidden document: B's pedido (the entrega's only upstream; nothing downstream yet).
    expect(forA.hidden).toBe(1);
    const forWarehouse = await trail(bodega);
    expect(forWarehouse.nodes.map((n) => n.id)).toContain(theirs.id);
    expect(forWarehouse.hidden).toBe(0);
  });

  it("from_quote: B's cotización converted by the manager is B's; an unowned one is the converter's (R39-3)", async () => {
    const owned = await run<OrderOut>(gerente, "sales.order.from_quote", { quoteId: await acceptedQuote(userB), warehouseId });
    expect(await ownerOf(owned.id)).toEqual({ owner_id: userB, owner_source: "quote" });
    expect(owned).toMatchObject({ status: "saved", stage: "open", total: expect.any(Number) });
    const unowned = await run<OrderOut>(a, "sales.order.from_quote", { quoteId: await acceptedQuote(null), warehouseId });
    expect(await ownerOf(unowned.id)).toEqual({ owner_id: userA, owner_source: "direct" });
    expect(await visibleIds(a, [owned.id, unowned.id])).toEqual([unowned.id]);
    expect(await visibleIds(b, [owned.id, unowned.id])).toEqual([owned.id]);
  });

  it("from_quote by a converter who cannot see the result answers the trimmed result, and the pedido is the cotización owner's (R39-4)", async () => {
    const out = await run<OrderOut>(jefeCrm, "sales.order.from_quote", { quoteId: await acceptedQuote(userB), warehouseId });
    expect(out).toEqual({ id: expect.any(String), number: expect.stringMatching(/^PED-\d+$/), status: "saved", stage: "open", ownerId: userB, visible: false });
    expect(await ownerOf(out.id)).toEqual({ owner_id: userB, owner_source: "quote" });
    expect((await refusal(run(jefeCrm, "sales.order.consult", { id: out.id })))?.code).toBe("not_found");
    expect(await run(b, "sales.order.consult", { id: out.id })).toMatchObject({ id: out.id, number: out.number });
    // The hand-over is in the audit: the run of from_quote, the owner's diff.
    const audit = await sql<{ action: string; process_id: string; diff: Record<string, { old: unknown; new: unknown }> }[]>`
      select action, process_id, diff from kernel.audit_log where entity = 'sales.orders' and row_id = ${out.id} and action = 'update' and diff ? 'owner_id'`;
    expect(audit).toEqual([expect.objectContaining({ process_id: "sales.order.from_quote", diff: expect.objectContaining({ owner_id: { old: seed.users.jefeCrm, new: userB } }) })]);
    // The hand-over function refuses outside that run.
    await expect(withClaims(sql, jefeCrm.claims, (tx) => tx`select sales.order_hand_over(${out.id}::uuid, ${userA}::uuid)`)).rejects.toMatchObject({ code: "42501" });
  });

  it("sales.order_hand_over refuses, even inside a run of from_quote: another's pedido, one the caller did not create, a target that is not the cotización's owner (review M-5)", async () => {
    /** The function as the crm manager inside a run of sales.order.from_quote (the attribution runProcess sets), rolled back. */
    const handOver = (orderId: string, ownerId: string, processId: string | null = "sales.order.from_quote") =>
      withClaims(sql, jefeCrm.claims, async (tx) => {
        if (processId) await tx`select set_config('erp.audit_process_id', ${processId}, true)`;
        return tx`select sales.order_hand_over(${orderId}::uuid, ${ownerId}::uuid)`;
      });
    const refused = { code: "42501" };
    // 1. Another user's pedido (B's own, converted by B from B's cotización: the target is the quote owner).
    const bQuote = await acceptedQuote(userB);
    const othersOrder = await run<OrderOut>(b, "sales.order.from_quote", { quoteId: bQuote, warehouseId });
    await expect(handOver(othersOrder.id, userB)).rejects.toMatchObject(refused);
    // 2. Owned by the caller but created by someone else (the admin converted A's cotización; the owner set to the caller by hand).
    const aQuote = await acceptedQuote(userA);
    const notCreated = await run<OrderOut>(admin, "sales.order.from_quote", { quoteId: aQuote, warehouseId });
    await sql`update sales.orders set owner_id = ${seed.users.jefeCrm!} where id = ${notCreated.id}`;
    await expect(handOver(notCreated.id, userA)).rejects.toMatchObject(refused);
    // 3. The caller's own pedido from an unowned cotización: no target is the cotización's owner.
    const own = await run<OrderOut>(jefeCrm, "sales.order.from_quote", { quoteId: await acceptedQuote(null), warehouseId });
    expect(await ownerOf(own.id)).toEqual({ owner_id: seed.users.jefeCrm, owner_source: "direct" });
    await expect(handOver(own.id, userA)).rejects.toMatchObject(refused);
    // 4. Another process's run, and no run at all.
    await expect(handOver(own.id, userA, "sales.order.update")).rejects.toMatchObject(refused);
    await expect(handOver(own.id, userA, null)).rejects.toMatchObject(refused);
    expect(await ownerOf(own.id)).toEqual({ owner_id: seed.users.jefeCrm, owner_source: "direct" });
  });

  it("the trimmed from_quote result names the owner only when the caller may see sales.order.owner_id (review M-7, rule 14)", async () => {
    await sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${companyId}, ${jefeCrmRole}, 'sales.order', 'owner_id', 'hidden')`;
    try {
      const out = await run<OrderOut>(jefeCrm, "sales.order.from_quote", { quoteId: await acceptedQuote(userB), warehouseId });
      expect(out).toMatchObject({ visible: false, ownerId: null });
      expect(await ownerOf(out.id)).toEqual({ owner_id: userB, owner_source: "quote" });
    } finally {
      await sql`delete from kernel.field_permissions where company_id = ${companyId} and role_id = ${jefeCrmRole} and entity = 'sales.order' and field = 'owner_id'`;
    }
  });

  it("an approver without sales.order.reassign reads, approves and rejects a pedido waiting for approval, never another's ordinary pedido (review I-1, 0140)", async () => {
    await run(admin, "sales.settings.update", { orderApprovalDiscountPct: 5 });
    try {
      const pendingOne = await create(b, { lines: [{ productId: cafe, qty: 1, discountPct: 10 }] });
      const pendingTwo = await create(b, { lines: [{ productId: cafe, qty: 1, discountPct: 10 }] });
      const ordinary = await create(b);
      expect(pendingOne).toMatchObject({ status: "pending", requiresApproval: true });
      expect(ordinary.status).toBe("saved");
      expect(await visibleIds(aprobador, [pendingOne.id, pendingTwo.id, ordinary.id])).toEqual([pendingOne.id, pendingTwo.id].sort());
      expect(await run(aprobador, "sales.order.consult", { id: pendingOne.id })).toMatchObject({ id: pendingOne.id });
      expect((await refusal(run(aprobador, "sales.order.consult", { id: ordinary.id })))?.code).toBe("not_found");
      expect(await run(aprobador, "sales.order.approve", { id: pendingOne.id })).toMatchObject({ status: "approved" });
      expect(await run(aprobador, "sales.order.reject", { id: pendingTwo.id, reason: "Descuento muy alto" })).toMatchObject({ status: "rejected" });
      // Still readable after the decision (requires_approval stays set); a salesperson holds no approval, so A sees none of them.
      expect(await visibleIds(aprobador, [pendingOne.id, pendingTwo.id])).toEqual([pendingOne.id, pendingTwo.id].sort());
      expect(await visibleIds(a, [pendingOne.id, pendingTwo.id, ordinary.id])).toEqual([]);
    } finally {
      await run(admin, "sales.settings.update", { orderApprovalDiscountPct: null });
    }
  });

  it("sales.lock_orders_for_invoice answers and locks only the pedidos the caller may read (review M-3, 0140)", async () => {
    const theirs = await create(b);
    await run(b, "sales.order.confirm", { id: theirs.id });
    const locked = (caller: Caller) =>
      withClaims(sql, caller.claims, async (tx) => {
        await tx`select set_config('erp.audit_process_id', 'invoicing.invoice.issue', true)`;
        return tx<{ id: string; number: string | null; stage: string }[]>`select id, number, stage from sales.lock_orders_for_invoice(${[theirs.id]}::uuid[])`;
      });
    expect(await locked(a)).toEqual([]);
    expect(await locked(gerente)).toEqual([{ id: theirs.id, number: theirs.number, stage: "confirmed" }]);
    // No lock taken for A: while A's call holds its transaction open, another session locks the row at once (NOWAIT).
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let called!: () => void;
    const inside = new Promise<void>((resolve) => (called = resolve));
    const holding = withClaims(sql, a.claims, async (tx) => {
      await tx`select set_config('erp.audit_process_id', 'invoicing.invoice.issue', true)`;
      const rows = await tx`select id from sales.lock_orders_for_invoice(${[theirs.id]}::uuid[])`;
      called();
      await held;
      return rows;
    });
    await inside;
    try {
      await expect(sql.begin((tx) => tx`select id from sales.orders where id = ${theirs.id} for update nowait`)).resolves.toHaveLength(1);
    } finally {
      release();
    }
    expect(await holding).toHaveLength(0);
  });

  it("sales.order.reassign: refused without the permission, invalid_owner for a non-member, a no-op on the same owner, audited (R39-5)", async () => {
    const theirs = await create(b);
    expect((await refusal(run(a, REASSIGN, { id: theirs.id, ownerId: userA })))?.code).toBe("forbidden");
    expect((await refusal(run(b, REASSIGN, { id: theirs.id, ownerId: userA })))?.code).toBe("forbidden");
    for (const stranger of [foreignUser, randomUUID()]) {
      const refused = await refusal(run(gerente, REASSIGN, { id: theirs.id, ownerId: stranger }));
      expect(refused?.code).toBe("invalid_input");
      expect(refused?.message).toMatch(/^invalid_owner: El vendedor no pertenece a la empresa/);
    }
    const audits = () => sql<{ process_id: string; diff: Record<string, { old: unknown; new: unknown }> }[]>`
      select process_id, diff from kernel.audit_log where entity = 'sales.orders' and row_id = ${theirs.id} and action = 'update' and diff ? 'owner_id' order by occurred_at`;
    expect(await run(gerente, REASSIGN, { id: theirs.id, ownerId: userB })).toMatchObject({ id: theirs.id, ownerId: userB, changed: false });
    expect(await audits()).toEqual([]);
    expect(await run(gerente, REASSIGN, { id: theirs.id, ownerId: userA })).toMatchObject({ id: theirs.id, ownerId: userA, changed: true });
    expect(await ownerOf(theirs.id)).toEqual({ owner_id: userA, owner_source: "reassigned" });
    expect(await audits()).toEqual([{ process_id: REASSIGN, diff: expect.objectContaining({ owner_id: { old: userB, new: userA }, owner_source: { old: "direct", new: "reassigned" } }) }]);
    expect(await visibleIds(a, [theirs.id])).toEqual([theirs.id]);
    expect(await visibleIds(b, [theirs.id])).toEqual([]);
    // sales.order.update takes no owner: the field changes only through reassign.
    expect((await refusal(run(a, "sales.order.update", { id: theirs.id, ownerId: userB })))?.code).toBe("invalid_input");
  });

  it("sales.order.reassign works on a confirmed, a cancelled and a voided pedido (it moves visibility, not the document)", async () => {
    const confirmed = await create(b);
    await run(b, "sales.order.confirm", { id: confirmed.id });
    await run(gerente, REASSIGN, { id: confirmed.id, ownerId: userA });
    expect(await ownerOf(confirmed.id)).toEqual({ owner_id: userA, owner_source: "reassigned" });
    const cancelled = await create(b);
    await run(b, "sales.order.cancel", { id: cancelled.id, reason: "El cliente desistió" });
    await run(gerente, REASSIGN, { id: cancelled.id, ownerId: userA });
    expect(await ownerOf(cancelled.id)).toEqual({ owner_id: userA, owner_source: "reassigned" });
    // Voided through Anular (sales.order.void, review M-4): status voided, and the owner still moves.
    const voided = await create(b);
    await run(b, "sales.order.void", { id: voided.id, reason: "Pedido duplicado" });
    expect((await sql<{ status: string }[]>`select status from sales.orders where id = ${voided.id}`)[0]!.status).toBe("voided");
    await run(gerente, REASSIGN, { id: voided.id, ownerId: userA });
    expect(await ownerOf(voided.id)).toEqual({ owner_id: userA, owner_source: "reassigned" });
  });

  it("event consumers act as the system user and read every pedido (R39-10)", async () => {
    const theirs = await create(b);
    const ctx = buildConsumerContext(sql, { id: randomUUID(), event: "sales.order.confirmed", companyId, chainId: randomUUID(), createdAt: new Date() }, registry);
    const seen = await ctx.runProcess("sales.order.consult", { id: theirs.id });
    expect(seen).toMatchObject({ id: theirs.id });
  });

  // PostgREST's own login exists only on the CLI and compose stacks (as kernel role-claims.integration.test.ts).
  const localDb = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres").hostname);
  it.skipIf(!localDb)("a forged system claim through PostgREST (session user authenticator) does not lift the rule (R39-10)", async () => {
    const theirs = await create(b);
    const mine = await create(a);
    const forged = { role: "authenticated", sub: SYSTEM_USER_ID, tenant_id: seed.tenantId, company_ids: [companyId], active_company_id: companyId, role_ids: [seed.companies[0]!.adminRoleId] };
    const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    url.username = "authenticator";
    const rest = createDb(url.toString());
    try {
      const rows = await rest.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(forged)}, true)`;
        await tx`set local role authenticated`;
        return tx<{ id: string }[]>`select id from sales.v_orders where id = any(${[theirs.id, mine.id]}::uuid[])`;
      });
      expect(rows).toEqual([]);
      // Positive control: the same connection with B's real claims reads B's own pedido (so the empty answer is the rule, not the setup).
      const own = await rest.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...b.claims })}, true)`;
        await tx`set local role authenticated`;
        return tx<{ id: string }[]>`select id from sales.v_orders where id = any(${[theirs.id, mine.id]}::uuid[])`;
      });
      expect(own).toEqual([{ id: theirs.id }]);
    } finally {
      await rest.end();
    }
  });

  it("exports, the assistant's consults and the sales charts read only the caller's pedidos (review M-2, R39-11)", async () => {
    const mine = await create(a);
    const theirs = await create(b);
    await run(a, "sales.order.confirm", { id: mine.id });
    await run(b, "sales.order.confirm", { id: theirs.id });
    // Export (the grid's PDF / Excel / CSV, kernel.export.run's plan and reader) as A: only A's pedidos.
    const spec = { entity: "sales.order", format: "csv" as const, state: { filters: [], sort: [{ field: "seq", dir: "asc" as const }], page: 1, pageSize: 50, columns: ["number"] } };
    const exported = async (caller: Caller) => {
      const plan = await withClaims(sql, caller.claims, (tx) => planExport(tx, registry, spec));
      const numbers: string[] = [];
      for await (const row of exportRows(sql, caller.claims, plan)) numbers.push(String((row as Record<string, unknown>).number));
      return numbers;
    };
    const ownedNumbers = async (owner: string | null) =>
      (await sql<{ number: string }[]>`select number from sales.orders where company_id = ${companyId} and number is not null and (${owner}::uuid is null or owner_id = ${owner}::uuid) order by seq`).map((r) => r.number);
    expect(await exported(a)).toEqual(await ownedNumbers(userA));
    expect(await exported(a)).not.toContain(theirs.number);
    expect(await exported(gerente)).toContain(theirs.number);
    // The assistant's tools are the registry's consults run as the user (origin agent): the same refusal.
    const agent = (caller: Caller): Caller => ({ ...caller, origin: "agent" });
    expect((await refusal(run(agent(a), "sales.order.consult", { id: theirs.id })))?.code).toBe("not_found");
    expect((await run<{ rows: { id: string }[] }>(agent(a), "kernel.data.query", { entity: "sales.order", search: theirs.number! })).rows).toEqual([]);
    expect(await run(agent(b), "sales.order.consult", { id: theirs.id })).toMatchObject({ id: theirs.id });
    // The charts of the sales page: by stage and by month, as A, count and sum A's pedidos only.
    const charts = async (caller: Caller) => (await run<{ charts: { id: string; series: { points: { label: string; value: number }[] }[] }[] }>(caller, "kernel.home.kpis", { module: "sales" })).charts;
    const byStage = (await charts(a)).find((c) => c.id === "sales.orders_by_stage")!;
    const [stageCounts] = await sql<{ open: number; confirmed: number }[]>`
      select count(*) filter (where stage = 'open')::int as open, count(*) filter (where stage = 'confirmed')::int as confirmed
      from sales.orders where company_id = ${companyId} and status <> 'voided' and owner_id = ${userA}`;
    const point = (label: string) => byStage.series[0]!.points.find((p) => p.label === label)!.value;
    expect({ open: point("home.chart.point.order_open"), confirmed: point("home.chart.point.order_confirmed") }).toEqual(stageCounts);
    const byMonth = (await charts(a)).find((c) => c.id === "sales.orders_by_month")!;
    const [monthTotal] = await sql<{ total: string }[]>`
      select coalesce(sum(subtotal), 0)::text as total from sales.orders
      where company_id = ${companyId} and owner_id = ${userA} and status <> 'voided' and stage <> 'cancelled' and confirmed_at is not null
        and issue_date > (date_trunc('month', current_date) - interval '6 months')`;
    expect(byMonth.series[0]!.points.reduce((s, p) => s + p.value, 0)).toBeCloseTo(Number(monthTotal!.total), 2);
    const [allTotal] = await sql<{ total: string }[]>`
      select coalesce(sum(subtotal), 0)::text as total from sales.orders
      where company_id = ${companyId} and status <> 'voided' and stage <> 'cancelled' and confirmed_at is not null
        and issue_date > (date_trunc('month', current_date) - interval '6 months')`;
    expect(Number(allTotal!.total)).toBeGreaterThan(Number(monthTotal!.total));
  });

  it("the backfill of 0139: the cotización's owner, else the creator in the audit, else none (visible only to holders), with owner_source (R39-6)", async () => {
    // 1. From a cotización owned by B (converted by A: today's code before 0139 left the converter as owner).
    const quoteId = await acceptedQuote(userB);
    const fromQuote = await run<OrderOut>(gerente, "sales.order.from_quote", { quoteId, warehouseId });
    // 2. Created by A directly (the audit's insert row names A).
    const direct = await create(a);
    // 3. Written by the system (an event: the audit's insert names the system user) and 4. with no audit row at all (written with the
    // triggers off), both left with an owner that the backfill must not keep.
    const fixture = async () => {
      const id = randomUUID();
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`insert into sales.orders (id, seq, company_id, number, party_id, owner_id, issue_date, stage, currency, exchange_rate, status, requires_approval, posts)
          values (${id}, ${fixtureSeq++}, ${companyId}, ${`PED-X${fixtureSeq}`}, ${partyId}, ${userA}, '2026-11-05', 'open', 'COP', 1, 'saved', false, false)`;
      });
      return id;
    };
    const bySystem = await fixture();
    await sql`insert into kernel.audit_log (company_id, actor_user_id, origin, process_id, entity, row_id, action, diff, chain_id)
      values (${companyId}, ${SYSTEM_USER_ID}, 'event', 'sales.order.create', 'sales.orders', ${bySystem}, 'insert', '{}'::jsonb, ${randomUUID()})`;
    const silent = await fixture();
    const rollback = new Error("rollback");
    let seen: Record<string, { owner_id: string | null; owner_source: string }> = {};
    await sql.begin(async (tx) => {
      // As before 0139: every pedido owned by whoever ran the process, its source not known yet.
      await tx`update sales.orders set owner_id = ${userA}, owner_source = 'direct' where id = ${fromQuote.id}`;
      await tx`update sales.orders set owner_id = ${userB}, owner_source = 'direct' where id = ${direct.id}`;
      await tx.unsafe(section("backfill"));
      const rows = await tx<{ id: string; owner_id: string | null; owner_source: string }[]>`
        select id, owner_id, owner_source from sales.orders where id = any(${[fromQuote.id, direct.id, bySystem, silent]}::uuid[])`;
      seen = Object.fromEntries(rows.map((r) => [r.id, { owner_id: r.owner_id, owner_source: r.owner_source }]));
      // Each change is in the row audit, origin db (the migration's session has no user).
      const [audited] = await tx<{ origin: string; actor_user_id: string | null }[]>`
        select origin, actor_user_id from kernel.audit_log where entity = 'sales.orders' and row_id = ${direct.id} and action = 'update' and diff ? 'owner_source' order by occurred_at desc limit 1`;
      expect(audited).toEqual({ origin: "db", actor_user_id: null });
      throw rollback;
    }).catch((e: unknown) => { if (e !== rollback) throw e; });
    expect(seen[fromQuote.id]).toEqual({ owner_id: userB, owner_source: "backfill_quote" });
    expect(seen[direct.id]).toEqual({ owner_id: userA, owner_source: "backfill_audit" });
    expect(seen[bySystem]).toEqual({ owner_id: null, owner_source: "backfill_none" });
    expect(seen[silent]).toEqual({ owner_id: null, owner_source: "backfill_none" });
    // Rolled back: nothing changed.
    expect(await ownerOf(direct.id)).toEqual({ owner_id: userA, owner_source: "direct" });
  });

  it("the grant of 0139: roles that reassign deals, deliver or invoice get sales.order.reassign; a role that only sells does not (R39-7)", async () => {
    const rollback = new Error("rollback");
    let granted: string[] = [];
    await sql.begin(async (tx) => {
      const roles: Record<string, string> = {};
      for (const [name, process] of [["r_crm", "crm.opportunity.reassign"], ["r_create", "sales.delivery.create"], ["r_ship", "sales.delivery.ship"], ["r_from", "invoicing.invoice.from_orders"], ["r_issue", "invoicing.invoice.issue"], ["r_sell", "sales.order.create"], ["r_denied", "sales.delivery.ship"]] as const) {
        const [r] = await tx<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, ${name}, false) returning id`;
        roles[r!.id] = name;
        await tx`insert into kernel.process_permissions(company_id, role_id, process_id, allowed) values (${companyId}, ${r!.id}, ${process}, ${name !== "r_denied"})`;
      }
      await tx.unsafe(section("grant"));
      const rows = await tx<{ role_id: string }[]>`select role_id from kernel.process_permissions where process_id = ${REASSIGN} and role_id = any(${Object.keys(roles)}::uuid[])`;
      granted = rows.map((r) => roles[r.role_id]!).sort();
      throw rollback;
    }).catch((e: unknown) => { if (e !== rollback) throw e; });
    expect(granted).toEqual(["r_create", "r_crm", "r_from", "r_issue", "r_ship"]);
  });
});
