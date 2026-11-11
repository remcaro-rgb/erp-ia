import { randomUUID } from "node:crypto";
import { buildConsumerContext, consumers, enqueueEvent, kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, type Caller, type ProcessError } from "@erp/kernel";
import { needStub, seedTenant, testDb, withClaims, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { core } from "@erp/module-core";
import { inventory } from "@erp/module-inventory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planFor } from "../processes/commission-plan";
import { sales } from "../index";

// Commission plans and bases (plan 2B.2 Task 30.1, Part G design PG §5.1, §5.2, §5.5; owner items 156–158, 162, 163; rulings RG-11, RG-12,
// RG-14; migration 0156). A plan names the payee party (employee or agent), the users whose pedidos it covers, a default rate and per-category
// rates; one active plan per user at a date. When invoicing issues an invoice, sales' consumer of invoicing.invoice.issued records what was
// invoiced on the entregas (sales.delivery.record_invoiced) and then, as a SECOND, separate run, sales.commission.compute writes one base per
// invoice line billed from a pedido whose owner has an active plan at the invoice date (rate frozen, base in pesos and in the document's
// currency) and emits sales.commission.due. A salesperson reads only the plans that list them and their bases; whoever may run
// sales.commission.consult_all reads every one; the rates and amounts are confidential.
//
// The invoices are invoicing's (which depends on sales, so sales' tests never load it): each issued invoice here is the outbox row
// invoicing.invoice.issued with the payload invoicing writes since Task 30.1 (`commissionLines`), handed to sales' consumer as the dispatch
// workflow does. invoicing/src/__tests__/invoice.integration.test.ts pins that invoicing writes that payload from a real invoice.

const registry = new Registry();
loadModules(registry, [kernelModule, core, inventory, needStub("costing"), sales]);
const PROCESS_IDS = ["kernel", "core", "inventory", "sales"].flatMap((m) => registry.processes({ module: m })).map((p) => p.id);
const CONSULT_ALL = "sales.commission.consult_all";

const party = (kind: string[], documentNumber: string, legalName: string) => ({
  kind, personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@tercero.example",
  ...(kind.includes("supplier") ? { supplierEmail: "compras@tercero.example" } : {}),
});

interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }
interface PlanInput { name: string; payeePartyId: string; payeeKind: "employee" | "agent"; defaultRatePct: number; paymentDays?: number; validFrom: string; validTo?: string; userIds: string[]; lines: { categoryId: string; ratePct: number }[] }
interface BaseRow { invoice_line_id: string; order_line_id: string; order_id: string; user_id: string; plan_id: string; payee_party_id: string; payee_kind: string; basis: string; rate_pct: string; base: string; base_doc: string; currency: string; commission: string; commission_doc: string; accrued: string; reversed: string; status: string }

describe("commission plans and bases (Task 30.1, migration 0156)", () => {
  const sql = testDb();
  let seed: SeededTenant;
  let companyId: string;
  let otherCompanyId: string;
  let admin: Caller;
  let andrea: Caller;
  let bruno: Caller;
  let contador: Caller;
  /** Holds sales.commission.consult_all but reads no confidential field (the role defaults mask them). */
  let auditor: Caller;
  let userAndrea: string;
  let userBruno: string;
  let userSinPlan: string;
  let customerId: string;
  let payeeAndrea: string;
  let payeeBruno: string;
  let notReady: string;
  let molido: string;
  let grano: string;
  let cafeMolido: string;
  let cafeGrano: string;
  let warehouseId: string;
  let planAndrea: string;
  let planBruno: string;

  const run = <T = unknown>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (ProcessError & { details: unknown }) | null;
  const grant = async (roleId: string, ids: string[]) => {
    for (const id of ids) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, ${id}) on conflict do nothing`;
  };
  const role = async (name: string) => (await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, ${name}, false) returning id`)[0]!.id;
  // A role claim counts only with its membership row (kernel.current_role_ids).
  const asUser = async (user: string, roleId: string): Promise<Caller> => {
    await sql`insert into kernel.membership_roles (membership_id, role_id)
      select id, ${roleId} from kernel.memberships where user_id = ${user} and company_id = ${companyId} on conflict do nothing`;
    return { claims: { ...seed.claimsFor(user, companyId), role_ids: [roleId] } as JwtClaims, origin: "ui" };
  };
  const markReady = async (id: string) => {
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'core.party', ${id}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${seed.tenantId}/${companyId}/core.party/${id}/${randomUUID()}.pdf`})`;
    }
  };
  const newParty = async (kind: string[], documentNumber: string, legalName: string, ready = true) => {
    const id = (await run<{ id: string }>(admin, "core.party.create", party(kind, documentNumber, legalName))).id;
    if (ready) await markReady(id);
    return id;
  };
  const createPlan = (input: PlanInput) => run<{ id: string }>(admin, "sales.commission_plan.create", input);

  /** A pedido of `lines` (20.000 each) owned by `ownerId`: created by the admin and reassigned to the salesperson. */
  const orderOf = async (ownerId: string, lines: { productId: string; qty: number }[]) => {
    const order = await run<{ id: string }>(admin, "sales.order.create", { partyId: customerId, issueDate: "2026-11-05", warehouseId, lines: lines.map((l) => ({ ...l, unitPrice: 20000 })) });
    await run(admin, "sales.order.reassign", { id: order.id, ownerId });
    const rows = await sql<{ id: string; product_id: string }[]>`select id, product_id from sales.order_lines where order_id = ${order.id} order by line_no`;
    return { id: order.id, lines: rows.map((r) => ({ id: r.id, productId: r.product_id })) };
  };

  interface IssuedLine { orderId?: string; orderLineId?: string; productId: string; categoryId: string | null; subtotal: number; subtotalDoc?: number }
  /**
   * The outbox row invoicing.invoice.issued of a fresh invoice (the payload of invoicing's post hook): `lines` are the revenue lines, and the
   * ones billed from a pedido are its commissionLines too. Returns the invoice id, its line ids and the row.
   */
  const issue = async (lines: IssuedLine[], options: { date?: string; currency?: string; exchangeRate?: number } = {}) => {
    const invoiceId = randomUUID();
    const lineIds = lines.map(() => randomUUID());
    const currency = options.currency ?? "COP";
    const exchangeRate = options.exchangeRate ?? 1;
    const payload = {
      date: options.date ?? "2026-11-10",
      number: `SETP${Math.floor(Math.random() * 1e6)}`,
      invoiceId,
      dueDate: "2026-12-10",
      customer: { partyId: customerId, legalName: "Cliente" },
      totals: { total: lines.reduce((s, l) => s + l.subtotal, 0), totalDoc: lines.reduce((s, l) => s + (l.subtotalDoc ?? l.subtotal), 0) },
      lines: lines.map((l) => ({ subtotal: l.subtotal, subtotalDoc: l.subtotalDoc ?? l.subtotal, categoryId: l.categoryId })),
      taxes: [],
      currency,
      exchangeRate,
      orderIds: [...new Set(lines.flatMap((l) => (l.orderId ? [l.orderId] : [])))],
      deliveryIds: [],
      commissionLines: lines.flatMap((l, i) => (l.orderLineId
        ? [{ invoiceLineId: lineIds[i]!, orderId: l.orderId!, orderLineId: l.orderLineId, productId: l.productId, categoryId: l.categoryId, subtotal: l.subtotal, subtotalDoc: l.subtotalDoc ?? l.subtotal }]
        : [])),
    };
    const id = await sql.begin((tx) => enqueueEvent(tx, { companyId, event: "invoicing.invoice.issued", payload, chainId: randomUUID() }));
    const [row] = await sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where id = ${id}`;
    return { invoiceId, lineIds, row: row! };
  };
  /** Hands an outbox row to sales' consumer of its event, as the dispatch workflow does (origin event, the row's chain). */
  const deliver = async (row: OutboxRow) => {
    const consumer = consumers.for(row.event).find((c) => c.moduleId === "sales")!;
    await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
  };
  const basesOf = (invoiceId: string) => sql<BaseRow[]>`
    select invoice_line_id, order_line_id, order_id, user_id, plan_id, payee_party_id, payee_kind, basis, rate_pct::text, base::text, base_doc::text, currency,
           commission::text, commission_doc::text, accrued::text, reversed::text, status
    from sales.commission_bases where invoice_id = ${invoiceId} order by seq`;
  const dueEvents = (invoiceId: string) => sql<{ payload: Record<string, unknown> }[]>`
    select payload from kernel.outbox where company_id = ${companyId} and event = 'sales.commission.due' and payload->>'invoiceId' = ${invoiceId}`;

  beforeAll(async () => {
    registerCountryPack(co);
    for (const m of [core, inventory, sales]) await syncModuleManifest(sql, m);
    seed = await seedTenant(sql, {
      companies: 2,
      users: [
        { name: "andrea", companies: [0], role: "member" },
        { name: "bruno", companies: [0], role: "member" },
        { name: "sinplan", companies: [0], role: "member" },
        { name: "contador", companies: [0], role: "member" },
        { name: "auditor", companies: [0], role: "member" },
      ],
      entitlements: ["module:core", "module:inventory", "module:sales"],
    });
    companyId = seed.companies[0]!.id;
    otherCompanyId = seed.companies[1]!.id;
    await grant(seed.companies[0]!.adminRoleId, PROCESS_IDS);
    admin = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };
    userAndrea = seed.users.andrea!;
    userBruno = seed.users.bruno!;
    userSinPlan = seed.users.sinplan!;

    const reading = ["kernel.data.query", "sales.commission_plan.consult"];
    const vendedor = await role("vendedor");
    await grant(vendedor, reading);
    const contadorRole = await role("contador");
    await grant(contadorRole, [...reading, CONSULT_ALL]);
    const auditorRole = await role("auditor");
    await grant(auditorRole, [...reading, CONSULT_ALL]);
    // The role defaults a role created in Administración gets (kernel.seed_role_defaults): every confidential field masked.
    await sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode)
      select ${companyId}, ${auditorRole}, entity, field, 'masked' from kernel.entity_fields where sensitivity = 'confidential' and entity like 'sales.commission%'
      on conflict do nothing`;
    andrea = await asUser(userAndrea, vendedor);
    bruno = await asUser(userBruno, vendedor);
    contador = await asUser(seed.users.contador!, contadorRole);
    auditor = await asUser(seed.users.auditor!, auditorRole);

    customerId = await newParty(["customer"], "860002964", "Distribuidora Andina S.A.S.");
    payeeAndrea = await newParty(["employee"], "52123456", "Andrea Gómez");
    payeeBruno = await newParty(["supplier"], "900111222", "Agencia Bruno S.A.S.");
    notReady = await newParty(["supplier"], "900333444", "Agente Sin Papeles S.A.S.", false);
    molido = (await run<{ id: string }>(admin, "core.category.create", { name: "Café molido", ivaRate: "5" })).id;
    grano = (await run<{ id: string }>(admin, "core.category.create", { name: "Café en grano", ivaRate: "5" })).id;
    const product = async (sku: string, categoryId: string) => (await run<{ id: string }>(admin, "core.product.create", {
      sku, description: `Café ${sku}`, kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, trackStock: true, categoryId,
    })).id;
    cafeMolido = await product("CAF-MOL", molido);
    cafeGrano = await product("CAF-GRA", grano);
    warehouseId = (await run<{ id: string }>(admin, "inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: true })).id;

    planAndrea = (await createPlan({
      name: "Andrea 2026", payeePartyId: payeeAndrea, payeeKind: "employee", defaultRatePct: 5, validFrom: "2026-01-01", validTo: "2026-12-31",
      userIds: [userAndrea], lines: [{ categoryId: molido, ratePct: 7 }],
    })).id;
    planBruno = (await createPlan({ name: "Agencia Bruno", payeePartyId: payeeBruno, payeeKind: "agent", defaultRatePct: 3, paymentDays: 45, validFrom: "2026-01-01", userIds: [userBruno], lines: [] })).id;
  });

  afterAll(async () => {
    const companyIds = [companyId, otherCompanyId];
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const tables = await tx<{ schema: string; name: string }[]>`
        select c.table_schema as schema, c.table_name as name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = any(${["sales", "inventory", "core"]}) and c.column_name = 'company_id'`;
      for (const t of tables) await tx`delete from ${tx(`${t.schema}.${t.name}`)} where company_id = any(${companyIds}::uuid[])`;
    });
    await sql`delete from kernel.record_snapshots where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.process_idempotency where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.field_permissions where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
    await seed.cleanup();
    await sql.end();
  });

  it("(1) 0156's tables have RLS (another company reads nothing), row audit and seq", async () => {
    const tables = ["commission_plans", "commission_plan_users", "commission_plan_lines", "commission_bases", "commissions", "commission_lines"];
    const rls = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'sales' and c.relname = any(${tables})`;
    expect(rls.map((r) => r.relname).sort()).toEqual([...tables].sort());
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    for (const table of tables) {
      const audit = await sql`select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'sales' and c.relname = ${table} and t.tgname like '%audit%'`;
      expect(audit.length, `${table} has the row audit`).toBeGreaterThan(0);
    }
    const [plan] = await sql<{ seq: string }[]>`select seq::text from sales.commission_plans where id = ${planAndrea}`;
    expect(Number(plan!.seq)).toBeGreaterThan(0);
    const [audited] = await sql`select 1 from kernel.audit_log where company_id = ${companyId} and entity = 'sales.commission_plans' and row_id = ${planAndrea}`;
    expect(audited).toBeDefined();
    const [users] = await sql<{ n: number }[]>`select count(*)::int as n from sales.commission_plan_users where plan_id = ${planAndrea}`;
    expect(users!.n).toBe(1);
    const other: Caller = { claims: seed.claimsFor(seed.users.both, otherCompanyId) as JwtClaims, origin: "ui" };
    for (const view of ["v_commission_plans", "v_commission_bases", "v_commissions"]) {
      const rows = await withClaims(sql, other.claims, (tx) => tx`select id from ${tx(`sales.${view}`)}`);
      expect(rows, `${view} of another company`).toEqual([]);
    }
    const plain = await withClaims(sql, other.claims, (tx) => tx`select id from sales.commission_plans`);
    expect(plain).toEqual([]);
  });

  it("(2) plan create refuses an overlapping plan for the same user and a payee party that is not invoice-ready", async () => {
    const overlap = await refusal(createPlan({ name: "Andrea segundo semestre", payeePartyId: payeeAndrea, payeeKind: "employee", defaultRatePct: 4, validFrom: "2026-07-01", userIds: [userAndrea], lines: [] }));
    expect(overlap?.message).toMatch(/^commission_plan_overlap/);
    const notInvoiceReady = await refusal(createPlan({ name: "Agente", payeePartyId: notReady, payeeKind: "agent", defaultRatePct: 2, validFrom: "2026-01-01", userIds: [userSinPlan], lines: [] }));
    expect(notInvoiceReady?.message).toMatch(/^party_not_invoice_ready/);
    expect((notInvoiceReady?.details as string[]).join(" ")).toMatch(/faltan archivos/);
    // Before Andrea's plan starts (2025) does not overlap; nor does it after an inactive plan.
    const earlier = await createPlan({ name: "Andrea 2025", payeePartyId: payeeAndrea, payeeKind: "employee", defaultRatePct: 4, validFrom: "2025-01-01", validTo: "2025-12-31", userIds: [userAndrea], lines: [] });
    expect(earlier.id).toBeTruthy();
    // update refuses the overlap too (stretching 2025 into 2026).
    const stretched = await refusal(run(admin, "sales.commission_plan.update", { id: earlier.id, validTo: "2026-02-01" }));
    expect(stretched?.message).toMatch(/^commission_plan_overlap/);
    // An inactive plan does not count.
    await run(admin, "sales.commission_plan.update", { id: earlier.id, isActive: false, validTo: "2026-02-01" });
    const plan = await run<{ id: string; userIds: string[]; lines: { categoryId: string; ratePct: number }[] }>(admin, "sales.commission_plan.consult", { id: planAndrea });
    expect(plan.userIds).toEqual([userAndrea]);
    expect(plan.lines).toEqual([{ categoryId: molido, ratePct: 7 }]);
  });

  it("planFor answers the active plan of a user at a date", async () => {
    const at = (userId: string, date: string) => withClaims(sql, admin.claims, (tx) => planFor(tx, userId, date));
    expect((await at(userAndrea, "2026-11-10"))?.id).toBe(planAndrea);
    expect(await at(userSinPlan, "2026-11-10")).toBeNull();
  });

  it("(3) an invoice billed from Andrea's pedido writes one base per line with the frozen rates and amounts to the cent, and emits sales.commission.due", async () => {
    const order = await orderOf(userAndrea, [{ productId: cafeMolido, qty: 3 }, { productId: cafeGrano, qty: 2 }]);
    const { invoiceId, lineIds, row } = await issue([
      { orderId: order.id, orderLineId: order.lines[0]!.id, productId: cafeMolido, categoryId: molido, subtotal: 123456.78 },
      { orderId: order.id, orderLineId: order.lines[1]!.id, productId: cafeGrano, categoryId: grano, subtotal: 40000.1 },
    ]);
    await deliver(row);
    const bases = await basesOf(invoiceId);
    expect(bases).toEqual([
      expect.objectContaining({ invoice_line_id: lineIds[0], order_line_id: order.lines[0]!.id, order_id: order.id, user_id: userAndrea, plan_id: planAndrea, payee_party_id: payeeAndrea, payee_kind: "employee", basis: "on_collection", status: "open", currency: "COP" }),
      expect.objectContaining({ invoice_line_id: lineIds[1], plan_id: planAndrea }),
    ]);
    // 7 % of 123.456,78 = 8.641,9746 → 8.641,97; 5 % of 40.000,10 = 2.000,005 → 2.000,01 (half up).
    expect(bases.map((b) => [Number(b.rate_pct), Number(b.base), Number(b.commission), Number(b.base_doc), Number(b.commission_doc), Number(b.accrued), Number(b.reversed)])).toEqual([
      [7, 123456.78, 8641.97, 123456.78, 8641.97, 0, 0],
      [5, 40000.1, 2000.01, 40000.1, 2000.01, 0, 0],
    ]);
    expect((await dueEvents(invoiceId)).map((e) => e.payload)).toEqual([{ invoiceId, basis: "on_collection" }]);
    // Idempotent on the invoice: a redelivery writes nothing twice and emits no second due.
    await deliver(row);
    expect(await basesOf(invoiceId)).toHaveLength(2);
    expect(await dueEvents(invoiceId)).toHaveLength(1);
    // The rate is frozen: a later change of the plan does not touch the base.
    await run(admin, "sales.commission_plan.update", { id: planAndrea, lines: [{ categoryId: molido, ratePct: 9 }] });
    expect(Number((await basesOf(invoiceId))[0]!.rate_pct)).toBe(7);
    await run(admin, "sales.commission_plan.update", { id: planAndrea, lines: [{ categoryId: molido, ratePct: 7 }] });
  });

  it("(4) a line without a pedido line writes no base; an invoice covering two owners writes bases under two plans", async () => {
    const free = await issue([{ productId: cafeGrano, categoryId: grano, subtotal: 50000 }]);
    await deliver(free.row);
    expect(await basesOf(free.invoiceId)).toEqual([]);
    expect(await dueEvents(free.invoiceId)).toEqual([]);

    const ofAndrea = await orderOf(userAndrea, [{ productId: cafeMolido, qty: 1 }]);
    const ofBruno = await orderOf(userBruno, [{ productId: cafeMolido, qty: 1 }]);
    const both = await issue([
      { orderId: ofAndrea.id, orderLineId: ofAndrea.lines[0]!.id, productId: cafeMolido, categoryId: molido, subtotal: 100000 },
      { orderId: ofBruno.id, orderLineId: ofBruno.lines[0]!.id, productId: cafeMolido, categoryId: molido, subtotal: 90000 },
      { productId: cafeGrano, categoryId: grano, subtotal: 10000 },
    ]);
    await deliver(both.row);
    const bases = await basesOf(both.invoiceId);
    expect(bases.map((b) => [b.plan_id, b.user_id, b.payee_kind, Number(b.rate_pct), Number(b.commission)])).toEqual([
      [planAndrea, userAndrea, "employee", 7, 7000],
      [planBruno, userBruno, "agent", 3, 2700],
    ]);
  });

  it("(5) a USD invoice writes the base in pesos at the invoice's rate and base_doc in dollars", async () => {
    const order = await orderOf(userAndrea, [{ productId: cafeGrano, qty: 1 }]);
    const { invoiceId } = await issue(
      [{ orderId: order.id, orderLineId: order.lines[0]!.id, productId: cafeGrano, categoryId: grano, subtotal: 51543.13, subtotalDoc: 12.5 }],
      { currency: "USD", exchangeRate: 4123.45 },
    ).then(async (issued) => {
      await deliver(issued.row);
      return issued;
    });
    const [base] = await basesOf(invoiceId);
    expect(base).toMatchObject({ currency: "USD" });
    // 5 % of $ 51.543,13 = 2.577,1565 → 2.577,16; 5 % of USD 12,50 = 0,625 → 0,63.
    expect([Number(base!.base), Number(base!.base_doc), Number(base!.commission), Number(base!.commission_doc)]).toEqual([51543.13, 12.5, 2577.16, 0.63]);
  });

  it("(6) a seller without a plan earns nothing: no base, no sales.commission.due", async () => {
    const order = await orderOf(userSinPlan, [{ productId: cafeMolido, qty: 1 }]);
    const { invoiceId, row } = await issue([{ orderId: order.id, orderLineId: order.lines[0]!.id, productId: cafeMolido, categoryId: molido, subtotal: 80000 }]);
    await deliver(row);
    expect(await basesOf(invoiceId)).toEqual([]);
    expect(await dueEvents(invoiceId)).toEqual([]);
    // A plan that is not valid at the invoice date neither: Andrea's 2025 plan does not cover a 2026 invoice, her 2026 plan not a 2027 one.
    const ofAndrea = await orderOf(userAndrea, [{ productId: cafeMolido, qty: 1 }]);
    const later = await issue([{ orderId: ofAndrea.id, orderLineId: ofAndrea.lines[0]!.id, productId: cafeMolido, categoryId: molido, subtotal: 80000 }], { date: "2027-01-05" });
    await deliver(later.row);
    expect(await basesOf(later.invoiceId)).toEqual([]);
  });

  it("(7) Andrea reads her plan and bases, Bruno none of hers, the contador all; a role without the sensitivity sees the amounts masked", async () => {
    const plansOf = async (caller: Caller) => (await withClaims(sql, caller.claims, (tx) => tx<{ id: string; default_rate_pct: string | null }[]>`
      select id, default_rate_pct::text from sales.v_commission_plans where id = any(${[planAndrea, planBruno]}::uuid[]) order by name`));
    const basesFor = async (caller: Caller) => (await withClaims(sql, caller.claims, (tx) => tx<{ plan_id: string; commission: string | null; rate_pct: string | null; base: string | null }[]>`
      select plan_id, commission::text, rate_pct::text, base::text from sales.v_commission_bases`));
    expect((await plansOf(andrea)).map((p) => p.id)).toEqual([planAndrea]);
    expect(new Set((await basesFor(andrea)).map((b) => b.plan_id))).toEqual(new Set([planAndrea]));
    expect((await plansOf(bruno)).map((p) => p.id)).toEqual([planBruno]);
    expect((await basesFor(bruno)).every((b) => b.plan_id === planBruno)).toBe(true);
    expect((await basesFor(bruno)).length).toBeGreaterThan(0);
    // The plan users and lines follow the plan: Bruno reads none of Andrea's.
    const brunoUsers = await withClaims(sql, bruno.claims, (tx) => tx<{ plan_id: string }[]>`select plan_id from sales.commission_plan_users`);
    expect(brunoUsers.every((u) => u.plan_id === planBruno)).toBe(true);
    const brunoLines = await withClaims(sql, bruno.claims, (tx) => tx`select id from sales.v_commission_plan_lines where plan_id = ${planAndrea}`);
    expect(brunoLines).toEqual([]);
    // Bruno cannot consult Andrea's plan by id either (the kernel's record read gate, or the view: never her data).
    expect(["forbidden", "not_found"]).toContain((await refusal(run(bruno, "sales.commission_plan.consult", { id: planAndrea })))?.code);
    // The contador (sales.commission.consult_all) reads every plan and base, amounts visible.
    expect((await plansOf(contador)).map((p) => p.id).sort()).toEqual([planAndrea, planBruno].sort());
    const all = await basesFor(contador);
    expect(new Set(all.map((b) => b.plan_id))).toEqual(new Set([planAndrea, planBruno]));
    expect(all.every((b) => b.commission !== null && b.rate_pct !== null && b.base !== null)).toBe(true);
    // The auditor reads every row but the confidential rates and amounts masked.
    const masked = await basesFor(auditor);
    expect(masked.length).toBe(all.length);
    expect(masked.every((b) => b.commission === null && b.rate_pct === null && b.base === null)).toBe(true);
    expect((await plansOf(auditor)).every((p) => p.default_rate_pct === null)).toBe(true);
    // consult_all is never one of the consult processes a new role gets by default (owner 2026-11-10): an update-kind permission.
    expect(registry.process(CONSULT_ALL).kind).toBe("update");
  });

  it("(8) a failing compute does not roll back record_invoiced, and the redelivery records nothing twice", async () => {
    const order = await orderOf(userAndrea, [{ productId: cafeMolido, qty: 1 }]);
    const { invoiceId, row } = await issue([{ orderId: order.id, orderLineId: order.lines[0]!.id, productId: cafeMolido, categoryId: molido, subtotal: 60000 }]);
    const runs: string[] = [];
    // The fixture: any insert of a base fails (a trigger raising), as a compute that cannot write would.
    await sql.unsafe(`create function sales.test_fail_base() returns trigger language plpgsql as $$ begin raise exception 'compute fixture: forced failure'; end; $$`);
    await sql.unsafe("create trigger test_fail_base before insert on sales.commission_bases for each row execute function sales.test_fail_base()");
    try {
      const consumer = consumers.for(row.event).find((c) => c.moduleId === "sales")!;
      const ctx = buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry);
      const traced = { ...ctx, runProcess: async (processId: string, input: unknown) => { runs.push(processId); return ctx.runProcess(processId, input); } };
      await expect(consumer.fn(traced, row.payload)).rejects.toThrow(/sales\.commission\.compute/);
      // Two separate runs: record_invoiced committed on its own (its audit row is there) before compute failed.
      expect(runs).toEqual(["sales.delivery.record_invoiced", "sales.commission.compute"]);
      const [recorded] = await sql`select 1 from kernel.audit_log where company_id = ${companyId} and process_id = 'sales.delivery.record_invoiced' and chain_id = ${row.chain_id}`;
      expect(recorded).toBeDefined();
      expect(await basesOf(invoiceId)).toEqual([]);
      expect(await dueEvents(invoiceId)).toEqual([]);
    } finally {
      await sql.unsafe("drop trigger if exists test_fail_base on sales.commission_bases");
      await sql.unsafe("drop function if exists sales.test_fail_base()");
    }
    // The dispatcher retries the event: record_invoiced again (it recomputes, idempotent), compute writes the base once.
    await deliver(row);
    await deliver(row);
    expect(await basesOf(invoiceId)).toHaveLength(1);
    expect(await dueEvents(invoiceId)).toHaveLength(1);
  });

  it("sales.settings.update takes the commission basis (default on_collection); a later invoice's bases carry it", async () => {
    const [before] = await sql<{ commission_basis: string }[]>`select commission_basis from sales.settings where company_id = ${companyId}`;
    expect(before?.commission_basis ?? "on_collection").toBe("on_collection");
    const out = await run<{ commissionBasis: string }>(admin, "sales.settings.update", { commissionBasis: "on_invoice" });
    expect(out.commissionBasis).toBe("on_invoice");
    const bad = await refusal(run(admin, "sales.settings.update", { commissionBasis: "monthly" }));
    expect(bad?.code).toBe("invalid_input");
    const order = await orderOf(userAndrea, [{ productId: cafeMolido, qty: 1 }]);
    const { invoiceId, row } = await issue([{ orderId: order.id, orderLineId: order.lines[0]!.id, productId: cafeMolido, categoryId: molido, subtotal: 10000 }]);
    await deliver(row);
    expect((await basesOf(invoiceId))[0]!.basis).toBe("on_invoice");
    expect((await dueEvents(invoiceId))[0]!.payload).toEqual({ invoiceId, basis: "on_invoice" });
    await run(admin, "sales.settings.update", { commissionBasis: "on_collection" });
  });
});
