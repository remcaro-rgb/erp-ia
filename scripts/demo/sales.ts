/**
 * The sale chain of Café del Norte S.A.S. (plan 2B Task 26): what `pnpm db:seed` leaves in CRM, Ventas, Inventario, Costos, Facturación
 * and Pagos. LOCAL USE ONLY, like the rest of the seed. It runs after the accounting history (scripts/demo/accounting.ts), dated on the
 * company's today, so the history's months (January to October 2026, what accounting-smoke.spec.ts reads) keep their figures. Every write
 * is a registered process run as Laura (rule 1), with a fresh step-up where the process asks for one; every action runs on a causal chain
 * of its own and the outbox rows it causes are handed to their consumers as the dispatch workflow would (the CLI has no worker). In order:
 *
 *  1. Grants: the gerente comercial sells (CRM, pedidos, entregas, facturas), the contador and the cajero receive payments.
 *  2. Inventario: Bodega Principal (PRIN) with its estantería, and the opening stock of every good that keeps stock at its standard cost
 *     (two products are left under their minimum on purpose: the Stock bajo mínimo card has something to say); costing values it.
 *  3. Pagos: the medios de pago Transferencia Bancolombia and Efectivo.
 *  4. Facturación: the parameters (manual creation, DIAN habilitación, the software and test-set ids, the issuer's fiscal profile, the cost
 *     center of the revenue), the DIAN resolution of habilitación (prefix SETP, the DIAN's test range) and the numbering of credit and debit
 *     notes. The signing certificate and the software PIN are NOT configured: the demo submits through the mock DIAN below, never the DIAN.
 *  5. CRM: the embudo «Ventas institucionales» and an open oportunidad (the Pipeline card).
 *  6. ONE FULL CHAIN for Almacenes Éxito: oportunidad → cotización (enviada, aceptada) → pedido (confirmado, stock reservado) → entrega
 *     (despachada: stock out, costo de ventas) → factura (Por facturar, emitida: número SETP, CUFE, asiento) → aceptada por la DIAN (the MOCK
 *     DIAN, recorded through the e-invoice workflow's own processes, as test-support/mock-dian.mts does) → recibo de caja con retención en la
 *     fuente → factura pagada; everything linked by its documents.
 *  7. Two documents halfway, for the Inicio cards: Hotel Cumbre Andina's pedido shipped and not invoiced (Por facturar) and Supermercados
 *     La Colina's pedido confirmed and not delivered (Pedidos abiertos).
 *
 * Idempotent: each step looks for what an earlier run left (by code, title, the documents' links or their notes) and does only what is
 * missing, so a rerun changes nothing. A run interrupted in the middle of the chain resumes from the documents it finds.
 *
 *  8. The price list «Mayoristas» (plan 2B Task 51): every demo good at 10 % under its list price (whole pesos), created and priced through
 *     core.price_list.create and core.price_list_item.set, and named in Club Campestre El Rodeo's commercial terms. It comes AFTER the chain, so the
 *     chain's own documents keep the list prices their figures (CHAIN) are written for; the other specs keep list prices because their customers have no list.
 *
 *  9. The export sale in dollars (plan 2B.2 Task 34.8; FX §9): Northwind Roasters LLC with its required files, the USD rates of the last three
 *     days in Tasas de cambio (core.exchange_rate.set, origin ui), the price list «Exportación USD» in its terms, «Transferencia USD» into its
 *     own dollar account, FE-USD (USD 12.500,00, IVA exento por exportación, accepted by the mock DIAN) and a partial USD receipt of
 *     USD 5.000 at a lower rate (realized loss). See NORTHWIND and FOREIGN_SALE.
 *
 * 10. Commissions (plan 2B.2 Task 30.4, Part G design PG §6): Laura's plan as the company's salesperson (her employee party Laura Méndez, 5 %
 *     and 7 % on «Café molido»), an external agent's for Marcela's sales (Agencia Comercial del Caribe S.A.S., a supplier party, 4 %), and a
 *     sale of «Café molido» to Catering Corporativo Andes collected in two receipts (40 % and the rest): on the default basis (al recaudo)
 *     each receipt accrues its share, two COM documents that leave the payable open in Cartera por edades (CxP). See COMMISSION_PLANS and
 *     COMMISSION_SALE.
 *
 * 11. Lots and serials (plan 2B.2 Task 28.4, PG §3.5, §3.6): «Café molido tradicional 500 g» is followed by lot and the grinder by serial
 *     (inventory.product_tracking.set, step-up, BEFORE the opening stock, which leaves them out); in step 2 the lot product receives two
 *     lots of different expiry and the grinder three serials through inventory.movement.post; at the end a pedido of 30 to Distribuciones
 *     Andinas del Café ships by FEFO in two lots (20 of L-2311, 10 of L-2402) and is invoiced as a Borrador whose line carries both. See
 *     LOT_PRODUCT, SERIAL_PRODUCT and LOT_SALE.
 *
 * 12. Bodega (plan 2B.2 Task 29.4, PG §4, owner item 218), enabled here, after the earlier chain (whose pedidos are not picked): one
 *     storage ubicación per stocked category with its put-away rule; the FEFO pedido of 11 is picked (its alistamiento made on confirming,
 *     confirmed as proposed), delivered from its pick (the Borrador entrega carries the lots) and shipped, then packed and the empaque
 *     closed; a receipt at Estantería A is put away to its category's bin (inventory relocates it, no cost). See BINS, PACK, PUTAWAY_RECEIPT.
 *
 * Gap (reported in plan 2B Task 26): no certificate (see 4).
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { buildConsumerContext, consumers, disableModule, moduleGate, enableModule, runProcess, type Caller, type Registry, type RunProcessDeps } from "@erp/kernel";
import type { FileStore } from "@erp/infra";
import { DEMO_COMPANY_ID, DEMO_ROLE_IDS } from "./accounts";
import { COMMISSION_PLANS, COMMISSION_SALE } from "./commissions";
import { attachRequiredFiles } from "./files";
import type { DemoSession } from "./accounting";
import { FOREIGN_SALE, NORTHWIND, USD_BANK, USD_METHOD, USD_PRICE_LIST, USD_RATES } from "./foreign-sale";
import { LOT_PRODUCT, LOT_SALE, SERIAL_PRODUCT } from "./lots";
import { BINS, PACK, PUTAWAY_RECEIPT, RULE_PRIORITY } from "./warehouse";

/** The modules of the sale chain, in dependency order (each one's `dependsOn` is enabled before it). */
export const SALES_CHAIN_MODULES = ["inventory", "costing", "sales", "crm", "invoicing", "payments", "warehouse"] as const;
/** Enabled late, in step 12 (plan 2B.2 Task 29.4): the earlier pedidos are not picked. */
const LATE_MODULES: ReadonlySet<string> = new Set(["warehouse"]);

export const ALMACENES_EXITO = "890900608";
export const HOTEL_CUMBRE_ANDINA = "860512347";
export const LA_COLINA = "900456781";

export const WAREHOUSE = { code: "PRIN", name: "Bodega Principal" };
export const LOCATION = { code: "EST-A", name: "Estantería A" };
export const OPENING_REFERENCE = "Inventario inicial de demostración";
/** Goods left under their minimum stock: on hand, against the minimum of scripts/demo/data.ts. */
export const BELOW_MINIMUM: Record<string, number> = { "REP-TOR-ZAN": 5, "ACC-PRE-FRA": 2 };

export const METHODS = [
  { code: "TRF", name: "Transferencia Bancolombia", kind: "transfer", meansCode: "47" },
  { code: "EFE", name: "Efectivo", kind: "cash", meansCode: "10" },
] as const;

/**
 * The DIAN resolution of habilitación: the prefix and range the DIAN gives every test set (SETP 990000000–995000000), and the technical key
 * the DIAN publishes for its habilitación examples. NOT A SECRET and NOT VALID FOR PRODUCTION: a company in producción registers its own.
 */
export const HABILITACION_RESOLUTION = {
  prefix: "SETP",
  number: "18760000001",
  from: 990000000,
  to: 995000000,
  validFrom: "2019-01-19",
  validTo: "2030-01-19",
  technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c",
};

/** The DIAN software and test set of habilitación: placeholders (fake ids), flagged as such; the owner's real ones replace them. */
export const DEMO_DIAN_SOFTWARE = {
  softwareId: "00000000-0000-4000-8000-00000000de01",
  testSetId: "00000000-0000-4000-8000-00000000de02",
};

export const PIPELINE = {
  code: "INST",
  name: "Ventas institucionales",
  stages: [
    { name: "Prospección", probability: 10, kind: "open" },
    { name: "Propuesta", probability: 50, kind: "open" },
    { name: "Negociación", probability: 75, kind: "open" },
    { name: "Ganada", probability: 100, kind: "won" },
    { name: "Perdida", probability: 0, kind: "lost" },
  ],
} as const;

/** The deal still open: the Pipeline card's figure. */
export const OPEN_OPPORTUNITY = { title: "Dotación de cafeterías · Cadena Hotelera Sol del Caribe", party: "890112233", amount: 4_800_000 };

/** The full chain: 12 × Café en grano Norte Especial 500 g at $ 32.000 = $ 384.000 + IVA 5 % $ 19.200 = $ 403.200. */
export const CHAIN = {
  title: "Café en grano para Almacenes Éxito · cadena de demostración",
  party: ALMACENES_EXITO,
  sku: "CAF-GRA-500",
  qty: 12,
  subtotal: 384_000,
  total: 403_200,
  /** Retención en la fuente por compras 2,5 % that Éxito practises on the base. */
  retefuente: { kind: "income" as const, code: "RTEFTE_COMPRAS_2.5", rate: 2.5, base: 384_000, amount: 9_600 },
  reference: "TRF-EXITO-DEMO-01",
};

/** The price list of the demo (Task 51, R51-2): each good at 10 % under its list price, rounded to whole pesos; Éxito buys with it. */
/** Named in Club Campestre El Rodeo's terms, a customer no e2e spec prices, so the other specs keep list prices. */
export const PRICE_LIST = { name: "Mayoristas", currencyCode: "COP", discountPct: 10, customer: "890981234" };

/** The Mayoristas price of a good: 10 % under the list price, in whole pesos. */
export const wholesalePrice = (listPrice: number): number => Math.round((listPrice * (100 - PRICE_LIST.discountPct)) / 100);

// The export sale in dollars (Task 34.8): its figures live in ./foreign-sale, free of imports so the e2e specs can read them.
export { FOREIGN_SALE, NORTHWIND, USD_BANK, USD_METHOD, USD_PRICE_LIST, USD_RATES } from "./foreign-sale";

/** The halfway documents (by their notes). */
export const HALFWAY = [
  { notes: "Demostración: entregado y pendiente de facturar", party: HOTEL_CUMBRE_ANDINA, sku: "CAF-MOL-EXP", qty: 6, ship: true },
  { notes: "Demostración: pedido confirmado por entregar", party: LA_COLINA, sku: "CAF-MOL-500", qty: 24, ship: false },
] as const;

// The commissions of the demo (Task 30.4): their figures live in ./commissions, free of imports but the accounts, so the e2e specs can read them.
export { COMMISSION_PLANS, COMMISSION_SALE } from "./commissions";

/** Module consumers the seed does not run: invoicing's DIAN submission starts the e-invoice workflow (no Workflow World in the CLI). */
const NOT_RUN = new Set(["invoicing.invoice.issued|invoicing", "invoicing.note.issued|invoicing", "invoicing.invoice.resubmit_requested|invoicing"]);

interface Who {
  laura: DemoSession;
}

export interface SalesSeedResult {
  actions: number;
  chain: { quote: string | null; order: string | null; delivery: string | null; invoice: string | null; receipt: string | null };
  /** The export sale in dollars (step 9): FE-USD's number and its partial receipt's. */
  foreign: { invoice: string | null; receipt: string | null };
}

type Row = { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string };

const one = async <T>(rows: Promise<T[]>): Promise<T | undefined> => (await rows)[0];

/** The modules of the chain enabled for the demo company (the tenant holds their entitlements: supabase/seed.sql). */
export async function enableSalesChain(sql: Sql, registry: Registry): Promise<void> {
  for (const moduleId of SALES_CHAIN_MODULES) {
    if (!LATE_MODULES.has(moduleId)) await enableModule(sql, DEMO_COMPANY_ID, moduleId, registry);
    // An entitled module consumes events unless switched off (moduleGate): a late one stays off until its step (a rerun leaves it on).
    else if (!(await one(sql`select 1 from kernel.company_modules where company_id = ${DEMO_COMPANY_ID} and module_id = ${moduleId} and enabled`))) {
      await disableModule(sql, DEMO_COMPANY_ID, moduleId, registry);
    }
  }
}

export async function seedSalesChain(sql: Sql, deps: RunProcessDeps, who: Who, store: FileStore | null): Promise<SalesSeedResult> {
  const { laura } = who;
  let actions = 0;
  const chains = new Set<string>();
  /** One user action: Laura runs the process on a chain of its own (a fresh step-up when asked, the Parámetros screen's origin when asked). */
  const act = async <T = { id: string }>(processId: string, input: unknown, options: { stepUp?: boolean; ui?: boolean } = {}): Promise<T> => {
    const chainId = randomUUID();
    chains.add(chainId);
    actions++;
    const base = options.stepUp ? await laura.stepUp() : laura.caller;
    const caller: Caller = { ...base, chainId, ...(options.ui ? { origin: "ui" as const } : {}) };
    return (await runProcess<never>(deps, caller, processId, input)) as T;
  };

  /**
   * Hands every undispatched outbox row of the seed's chains to each consumer of its event until nothing new is emitted, as the dispatch
   * workflow does (one delivery per module, recorded; the row marked dispatched). A consumer that fails stops the seed with its cause.
   */
  const drain = async (): Promise<void> => {
    for (let round = 0; round < 30; round++) {
      const rows = await sql<Row[]>`
        select id, event, payload, created_at, chain_id from kernel.outbox
        where company_id = ${DEMO_COMPANY_ID} and dispatched_at is null and chain_id = any(${[...chains]}::uuid[]) order by created_at, id`;
      if (rows.length === 0) return;
      for (const row of rows) {
        for (const consumer of consumers.for(row.event)) {
          if (NOT_RUN.has(`${row.event}|${consumer.moduleId}`)) continue;
          // As the dispatcher's gate: a module the company does not have yet consumes nothing (Bodega until step 12, Task 29.4).
          if ((await moduleGate(sql, DEMO_COMPANY_ID, consumer.moduleId)) !== "enabled") continue;
          const [done] = await sql`select 1 from kernel.outbox_deliveries where outbox_id = ${row.id} and module_id = ${consumer.moduleId}`;
          if (done) continue;
          try {
            await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId: DEMO_COMPANY_ID, chainId: row.chain_id }, deps.registry), row.payload);
          } catch (error) {
            throw new Error(`demo sale chain: the ${consumer.moduleId} consumer of ${row.event} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, ${consumer.moduleId}) on conflict do nothing`;
        }
        await sql`update kernel.outbox set dispatched_at = now() where id = ${row.id} and dispatched_at is null`;
      }
    }
    throw new Error("demo sale chain: the outbox did not settle");
  };

  const [{ today }] = (await sql<{ today: string }[]>`
    select (now() at time zone coalesce(timezone, 'America/Bogota'))::date::text as today from kernel.companies where id = ${DEMO_COMPANY_ID}`) as [{ today: string }];
  const plusDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  // The fiscal year of today (the history's is 2026; a later run opens the year it falls in).
  const year = Number(today.slice(0, 4));
  if (!(await one(sql`select 1 from accounting.fiscal_years where company_id = ${DEMO_COMPANY_ID} and year = ${year}`))) await act("accounting.fiscal_year.open", { year });

  const partyId = async (document: string) => {
    const row = await one(sql<{ id: string }[]>`select id from core.parties where company_id = ${DEMO_COMPANY_ID} and document_number = ${document}`);
    if (!row) throw new Error(`demo sale chain: the party ${document} is not in the demo data`);
    return row.id;
  };
  const product = async (sku: string) => {
    const row = await one(sql<{ id: string }[]>`select id from core.products where company_id = ${DEMO_COMPANY_ID} and sku = ${sku}`);
    if (!row) throw new Error(`demo sale chain: the product ${sku} is not in the demo data`);
    return row.id;
  };
  const costCenter = (await one(sql<{ id: string }[]>`select id from accounting.cost_centers where company_id = ${DEMO_COMPANY_ID} and code = 'TOS'`))!.id;

  // 1. Grants (only what is missing).
  await grantSales(sql, act);

  // 2. Inventario: the bodega, its estantería, the opening stock (valued by costing's consumer).
  let warehouse = await one(sql<{ id: string }[]>`select id from inventory.warehouses where company_id = ${DEMO_COMPANY_ID} and code = ${WAREHOUSE.code}`);
  if (!warehouse) warehouse = await act("inventory.warehouse.create", { code: WAREHOUSE.code, name: WAREHOUSE.name, allowBackorders: false });
  const warehouseId = warehouse.id;
  let location = await one(sql<{ id: string }[]>`select id from inventory.locations where company_id = ${DEMO_COMPANY_ID} and warehouse_id = ${warehouseId} and code = ${LOCATION.code}`);
  if (!location) location = await act("inventory.location.create", { warehouseId, code: LOCATION.code, name: LOCATION.name });
  const opened = await one(sql`select 1 from inventory.movements where company_id = ${DEMO_COMPANY_ID} and reference = ${OPENING_REFERENCE} and status <> 'voided'`);
  // 11 (first half). The tracking of the lot and serial products, set while they hold no stock (a switch with stock is refused).
  if (!opened) {
    for (const [sku, tracking] of [[LOT_PRODUCT.sku, "lot"], [SERIAL_PRODUCT.sku, "serial"]] as const) {
      const productId = await product(sku);
      if (!(await one(sql`select 1 from inventory.product_tracking where product_id = ${productId} and tracking = ${tracking}`))) {
        await act("inventory.product_tracking.set", { productId, tracking }, { stepUp: true });
      }
    }
  }
  if (!opened) {
    // The tracked products start with their lots and serials below, not here.
    const goods = await sql<{ id: string; sku: string; min_stock: string | null; standard_cost: string | null }[]>`
      select p.id, p.sku, p.min_stock::text, p.standard_cost::text from core.products p
      where p.company_id = ${DEMO_COMPANY_ID} and p.track_stock and p.kind = 'good' and p.is_active
        and not exists (select 1 from inventory.product_tracking t where t.product_id = p.id and t.tracking <> 'none') order by p.sku`;
    const lines = goods.map((g) => ({
      productId: g.id,
      locationId: location!.id,
      qty: BELOW_MINIMUM[g.sku] ?? Math.max(Number(g.min_stock ?? 0) * 6, 60),
      unitCost: Number(g.standard_cost ?? 0),
    }));
    await act("inventory.movement.post", { kind: "receipt", date: today, warehouseId, reference: OPENING_REFERENCE, description: "Existencias con que arranca la demostración", lines });
    await drain();
  }
  // The lots (two expiries) and the serials, received through inventory.movement.post at the standard cost.
  const standardCost = async (sku: string) => Number((await one(sql<{ c: string | null }[]>`select standard_cost::text as c from core.products where company_id = ${DEMO_COMPANY_ID} and sku = ${sku}`))?.c ?? 0);
  if (!(await one(sql`select 1 from inventory.movements where company_id = ${DEMO_COMPANY_ID} and reference = ${LOT_PRODUCT.reference} and status <> 'voided'`))) {
    const productId = await product(LOT_PRODUCT.sku);
    const unitCost = await standardCost(LOT_PRODUCT.sku);
    await act("inventory.movement.post", {
      kind: "receipt", date: today, warehouseId, reference: LOT_PRODUCT.reference, description: "Lotes de café molido de demostración",
      lines: LOT_PRODUCT.lots.map((l) => ({ productId, locationId: location!.id, qty: l.qty, unitCost, lot: { code: l.code, expiresOn: plusDays(today, l.expiresInDays) } })),
    });
    await drain();
  }
  if (!(await one(sql`select 1 from inventory.movements where company_id = ${DEMO_COMPANY_ID} and reference = ${SERIAL_PRODUCT.reference} and status <> 'voided'`))) {
    const productId = await product(SERIAL_PRODUCT.sku);
    await act("inventory.movement.post", {
      kind: "receipt", date: today, warehouseId, reference: SERIAL_PRODUCT.reference, description: "Molinos de demostración",
      lines: [{ productId, locationId: location!.id, qty: SERIAL_PRODUCT.serials.length, unitCost: await standardCost(SERIAL_PRODUCT.sku), serials: SERIAL_PRODUCT.serials.map((serialNo) => ({ serialNo })) }],
    });
    await drain();
  }

  // 3. Pagos: the medios de pago.
  const methodIds: Record<string, string> = {};
  for (const method of METHODS) {
    const found = await one(sql<{ id: string }[]>`select id from payments.methods where company_id = ${DEMO_COMPANY_ID} and code = ${method.code}`);
    methodIds[method.code] = found?.id ?? (await act("payments.method.create", method)).id;
  }

  // 4. Facturación: parameters, the DIAN resolution of habilitación, the numbering of the notes.
  const [settings] = await sql<{ software_id: string | null }[]>`select software_id from invoicing.settings where company_id = ${DEMO_COMPANY_ID}`;
  if (!settings?.software_id) {
    await act("invoicing.settings.update", {
      invoiceCreation: "manual", dianEnvironment: "habilitacion", defaultCostCenterId: costCenter, creditDays: 30,
      softwareId: DEMO_DIAN_SOFTWARE.softwareId, softwareProviderTaxId: "900373115", testSetId: DEMO_DIAN_SOFTWARE.testSetId,
      issuerTaxResponsibilities: ["O-13"], issuerTaxScheme: "01", issuerDepartmentCode: "11", issuerMunicipalityCode: "11001",
    }, { stepUp: true });
  }
  const sequence = (type: string) => one(sql`select 1 from core.document_sequences where company_id = ${DEMO_COMPANY_ID} and document_type = ${type}`);
  if (!(await sequence("invoice"))) {
    const { prefix, ...resolution } = HABILITACION_RESOLUTION;
    // Parámetros de facturación › Resolución y numeración: a screen-only process (the technical key never reaches the assistant).
    await act("core.document_sequence.register", { documentType: "invoice", prefix, resolution }, { stepUp: true, ui: true });
  }
  for (const [type, prefix] of [["credit_note", "NC"], ["debit_note", "ND"]] as const) {
    if (!(await sequence(type))) await act("core.document_sequence.register", { documentType: type, prefix }, { stepUp: true, ui: true });
  }

  // 5. CRM: the embudo and the open deal.
  let pipeline = await one(sql<{ id: string }[]>`select id from crm.pipelines where company_id = ${DEMO_COMPANY_ID} and code = ${PIPELINE.code}`);
  if (!pipeline) pipeline = await act("crm.pipeline.create", PIPELINE);
  const pipelineId = pipeline.id;
  if (!(await one(sql`select 1 from crm.opportunities where company_id = ${DEMO_COMPANY_ID} and title = ${OPEN_OPPORTUNITY.title}`))) {
    const [proposal] = await sql<{ id: string }[]>`select id from crm.stages where pipeline_id = ${pipelineId} and name = 'Propuesta'`;
    await act("crm.opportunity.create", { title: OPEN_OPPORTUNITY.title, partyId: await partyId(OPEN_OPPORTUNITY.party), pipelineId, stageId: proposal!.id, amount: OPEN_OPPORTUNITY.amount, expectedClose: plusDays(today, 45) });
  }

  // 6. The full chain.
  const exito = await partyId(CHAIN.party);
  const cafe = await product(CHAIN.sku);
  let opportunity = await one(sql<{ id: string }[]>`select id from crm.opportunities where company_id = ${DEMO_COMPANY_ID} and title = ${CHAIN.title}`);
  if (!opportunity) opportunity = await act("crm.opportunity.create", { title: CHAIN.title, partyId: exito, pipelineId, amount: CHAIN.subtotal, expectedClose: plusDays(today, 15) });

  let quote = await one(sql<{ id: string; number: string; stage: string }[]>`select id, number, stage from crm.quotes where company_id = ${DEMO_COMPANY_ID} and opportunity_id = ${opportunity.id} and status <> 'voided'`);
  if (!quote) {
    const created = await act<{ id: string }>("crm.quote.create", { partyId: exito, opportunityId: opportunity.id, issueDate: today, validUntil: plusDays(today, 30), lines: [{ productId: cafe, qty: CHAIN.qty }] });
    quote = (await one(sql<{ id: string; number: string; stage: string }[]>`select id, number, stage from crm.quotes where id = ${created.id}`))!;
  }
  if (quote.stage === "open") await act("crm.quote.send", { id: quote.id });
  if (quote.stage === "open" || quote.stage === "sent") await act("crm.quote.accept", { id: quote.id });
  await drain();

  let order = await one(sql<{ id: string; number: string; stage: string }[]>`select id, number, stage from sales.orders where company_id = ${DEMO_COMPANY_ID} and quote_id = ${quote.id} and status <> 'voided'`);
  if (!order) {
    const created = await act<{ id: string }>("sales.order.from_quote", { quoteId: quote.id, warehouseId, issueDate: today });
    order = (await one(sql<{ id: string; number: string; stage: string }[]>`select id, number, stage from sales.orders where id = ${created.id}`))!;
  }
  if (order.stage === "open") await act("sales.order.confirm", { id: order.id });
  await drain();

  const deliveryId = await shipOrder(sql, act, drain, order.id, today, costCenter);

  let invoice = await chainInvoice(sql, order.id);
  if (!invoice) {
    const created = await act<{ invoices: { id: string }[] }>("invoicing.invoice.from_orders", { orderIds: [order.id] });
    invoice = (await chainInvoice(sql, order.id))!;
    if (invoice.id !== created.invoices[0]!.id) throw new Error("demo sale chain: Por facturar wrote an unexpected invoice");
  }
  if (invoice.stage === "draft") {
    await act("invoicing.invoice.issue", { id: invoice.id, idempotencyKey: `demo-chain-issue-${invoice.id}` });
    invoice = (await chainInvoice(sql, order.id))!;
  }
  await drain();
  if (invoice.dian_status !== "accepted") {
    await mockDianAccepts(sql, deps, store, invoice.id);
    chains.add((await one(sql<{ chain_id: string }[]>`select chain_id from kernel.outbox where company_id = ${DEMO_COMPANY_ID} and event = 'invoicing.invoice.issued' and payload->>'invoiceId' = ${invoice.id} order by created_at desc limit 1`))!.chain_id);
    await drain();
  }

  let receipt = await one(sql<{ id: string; number: string }[]>`
    select r.id, r.number from payments.receipts r join payments.receipt_allocations a on a.receipt_id = r.id
    where r.company_id = ${DEMO_COMPANY_ID} and a.invoice_id = ${invoice.id} and r.status <> 'voided' limit 1`);
  if (!receipt) {
    receipt = await act<{ id: string; number: string }>("payments.payment.receive", {
      partyId: exito, methodId: methodIds.TRF, amount: CHAIN.total - CHAIN.retefuente.amount, date: today, reference: CHAIN.reference,
      allocations: [{ invoiceId: invoice.id, amount: CHAIN.total, withholdings: [CHAIN.retefuente] }], idempotencyKey: `demo-chain-receipt-${invoice.id}`,
    });
  }
  await drain();

  // 7. The halfway documents.
  for (const doc of HALFWAY) {
    let half = await one(sql<{ id: string; stage: string }[]>`select id, stage from sales.orders where company_id = ${DEMO_COMPANY_ID} and notes = ${doc.notes} and status <> 'voided'`);
    if (!half) half = await act<{ id: string; stage: string }>("sales.order.create", { partyId: await partyId(doc.party), warehouseId, notes: doc.notes, lines: [{ productId: await product(doc.sku), qty: doc.qty }] });
    const [stage] = await sql<{ stage: string }[]>`select stage from sales.orders where id = ${half.id}`;
    if (stage!.stage === "open") await act("sales.order.confirm", { id: half.id });
    await drain();
    if (doc.ship) await shipOrder(sql, act, drain, half.id, today, costCenter);
  }

  // 8. The price list Mayoristas and the club's terms (after the chain: see the header).
  let list = await one(sql<{ id: string }[]>`select id from core.price_lists where company_id = ${DEMO_COMPANY_ID} and name = ${PRICE_LIST.name}`);
  if (!list) list = await act("core.price_list.create", { name: PRICE_LIST.name, currencyCode: PRICE_LIST.currencyCode });
  const priced = new Set((await sql<{ product_id: string }[]>`select product_id from core.price_list_items where price_list_id = ${list.id}`).map((r) => r.product_id));
  const goods = await sql<{ id: string; list_price: string }[]>`
    select id, list_price::text from core.products where company_id = ${DEMO_COMPANY_ID} and kind = 'good' and is_active and deleted_at is null and list_price > 0 order by sku`;
  for (const good of goods) {
    if (!priced.has(good.id)) await act("core.price_list_item.set", { priceListId: list.id, productId: good.id, price: wholesalePrice(Number(good.list_price)) });
  }
  const club = await partyId(PRICE_LIST.customer);
  const terms = await one(sql<{ price_list_id: string | null }[]>`select price_list_id from sales.customer_terms where party_id = ${club}`);
  if (!terms?.price_list_id) await act("sales.customer_terms.set", { partyId: club, priceListId: list.id });

  // 9. The export sale in dollars (after the Mayoristas list: Northwind buys with its own list in USD).
  if (!store) throw new Error("demo sale chain: the export sale needs the file store (Northwind's required files)");
  let northwind = await one(sql<{ id: string }[]>`select id from core.parties where company_id = ${DEMO_COMPANY_ID} and document_number = ${NORTHWIND.documentNumber}`);
  if (!northwind) {
    northwind = await act("core.party.create", {
      kind: ["customer"], personType: "1", documentType: NORTHWIND.documentType, documentNumber: NORTHWIND.documentNumber, legalName: NORTHWIND.legalName,
      taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ", countryCode: NORTHWIND.countryCode, addressLine: NORTHWIND.addressLine, invoiceEmail: NORTHWIND.invoiceEmail,
    });
  }
  const northwindId = northwind.id;
  const filed = await attachRequiredFiles(sql, deps, laura.caller, store, { partyId: northwindId, document: NORTHWIND.documentNumber, name: NORTHWIND.legalName, tags: ["RUT", "Cámara de Comercio"] });
  actions += filed;
  for (const { daysAgo, rate } of USD_RATES) {
    const rateDate = plusDays(today, -daysAgo);
    if (!(await one(sql`select 1 from core.exchange_rates where company_id = ${DEMO_COMPANY_ID} and currency = 'USD' and rate_date = ${rateDate}`))) {
      // Tasas de cambio › Registrar tasa (the demo calls no TRM feed: the rates are typed, as a company without the import would).
      await act("core.exchange_rate.set", { currency: "USD", rateDate, rate, note: "Tasa de demostración" }, { ui: true });
    }
  }
  let usdList = await one(sql<{ id: string }[]>`select id from core.price_lists where company_id = ${DEMO_COMPANY_ID} and name = ${USD_PRICE_LIST.name}`);
  if (!usdList) usdList = await act("core.price_list.create", { name: USD_PRICE_LIST.name, currencyCode: USD_PRICE_LIST.currencyCode });
  const exported = await product(USD_PRICE_LIST.sku);
  if (!(await one(sql`select 1 from core.price_list_items where price_list_id = ${usdList.id} and product_id = ${exported}`))) {
    await act("core.price_list_item.set", { priceListId: usdList.id, productId: exported, price: USD_PRICE_LIST.price });
  }
  const northwindTerms = await one(sql<{ price_list_id: string | null }[]>`select price_list_id from sales.customer_terms where party_id = ${northwindId}`);
  if (!northwindTerms?.price_list_id) await act("sales.customer_terms.set", { partyId: northwindId, priceListId: usdList.id });
  let usdMethod = await one(sql<{ id: string }[]>`select id from payments.methods where company_id = ${DEMO_COMPANY_ID} and code = ${USD_METHOD.code}`);
  if (!usdMethod) usdMethod = await act("payments.method.create", USD_METHOD);
  let usdBank = await one(sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${DEMO_COMPANY_ID} and code = ${USD_BANK.code}`);
  if (!usdBank) usdBank = await act("accounting.account.create", { code: USD_BANK.code, name: USD_BANK.name });
  const methodDimension = `payment_method_id:${usdMethod.id}`;
  if (!(await one(sql`select 1 from accounting.account_role_mappings where company_id = ${DEMO_COMPANY_ID} and role = 'cash' and dimension = ${methodDimension}`))) {
    // The medio de pago's «Contabilidad» tab (Task 34.8b): its dollars land in the dollar account, not in the peso bank.
    await act("accounting.account_role_mapping.update", { mappings: [{ role: "cash", dimension: methodDimension, accountId: usdBank.id }] }, { stepUp: true });
  }
  const foreignInvoice = () => one(sql<{ id: string; number: string | null; stage: string; dian_status: string }[]>`
    select id, number, stage, dian_status from invoicing.invoices where company_id = ${DEMO_COMPANY_ID} and party_id = ${northwindId} and notes = ${FOREIGN_SALE.notes} and status <> 'voided'`);
  let feUsd = await foreignInvoice();
  if (!feUsd) {
    // No price typed: the line takes USD 25,00 from Northwind's list; no rate typed: the invoice takes today's from Tasas de cambio.
    await act("invoicing.invoice.create", { partyId: northwindId, currency: "USD", issueDate: today, notes: FOREIGN_SALE.notes, lines: [{ productId: exported, qty: FOREIGN_SALE.qty }] });
    feUsd = (await foreignInvoice())!;
  }
  if (feUsd.stage === "draft") {
    await act("invoicing.invoice.issue", { id: feUsd.id, idempotencyKey: `demo-export-issue-${feUsd.id}` });
    feUsd = (await foreignInvoice())!;
  }
  await drain();
  if (feUsd.dian_status !== "accepted") {
    await mockDianAccepts(sql, deps, store, feUsd.id);
    chains.add((await one(sql<{ chain_id: string }[]>`select chain_id from kernel.outbox where company_id = ${DEMO_COMPANY_ID} and event = 'invoicing.invoice.issued' and payload->>'invoiceId' = ${feUsd.id} order by created_at desc limit 1`))!.chain_id);
    await drain();
  }
  let usdReceipt = await one(sql<{ id: string; number: string }[]>`
    select r.id, r.number from payments.receipts r join payments.receipt_allocations a on a.receipt_id = r.id
    where r.company_id = ${DEMO_COMPANY_ID} and a.invoice_id = ${feUsd.id} and r.status <> 'voided' limit 1`);
  if (!usdReceipt) {
    const { amount, rate, reference } = FOREIGN_SALE.receipt;
    usdReceipt = await act<{ id: string; number: string }>("payments.payment.receive", {
      partyId: northwindId, methodId: usdMethod.id, currency: "USD", exchangeRate: rate, amount, date: today, reference,
      allocations: [{ invoiceId: feUsd.id, amount }], idempotencyKey: `demo-export-receipt-${feUsd.id}`,
    });
  }
  await drain();

  // 10. Commissions: the payees (with their required files), the two plans, and the sale collected in two receipts.
  const payee = async (key: "employee" | "agent") => {
    const p = COMMISSION_PLANS[key].party;
    let row = await one(sql<{ id: string }[]>`select id from core.parties where company_id = ${DEMO_COMPANY_ID} and document_number = ${p.documentNumber}`);
    if (!row) {
      row = await act("core.party.create",
        key === "employee"
          ? { kind: ["employee"], personType: "2", documentType: "13", documentNumber: p.documentNumber, firstName: COMMISSION_PLANS.employee.party.firstName, firstSurname: COMMISSION_PLANS.employee.party.firstSurname,
              taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ", countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Calle 93 # 11-26", phoneCc: "57", phone: p.phone, invoiceEmail: p.email }
          : { kind: ["supplier"], personType: "1", documentType: "31", documentNumber: p.documentNumber, legalName: p.legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
              countryCode: "CO", departmentCode: "08", municipalityCode: "08001", addressLine: "Carrera 54 # 72-80", phoneCc: "57", phone: p.phone, supplierEmail: p.email, invoiceEmail: p.email });
    }
    actions += await attachRequiredFiles(sql, deps, laura.caller, store, { partyId: row.id, document: p.documentNumber, name: p.legalName, tags: key === "employee" ? ["RUT"] : ["RUT", "Cámara de Comercio"] });
    return row.id;
  };
  const userId = async (email: string) => (await one(sql<{ id: string }[]>`select id from kernel.users where email = ${email}`))!.id;
  const [ground] = await sql<{ id: string }[]>`select id from core.product_categories where company_id = ${DEMO_COMPANY_ID} and name = ${COMMISSION_PLANS.employee.category.name} and deleted_at is null`;
  for (const key of ["employee", "agent"] as const) {
    const plan = COMMISSION_PLANS[key];
    const payeePartyId = await payee(key);
    if (await one(sql`select 1 from sales.commission_plans where company_id = ${DEMO_COMPANY_ID} and name = ${plan.name} and deleted_at is null`)) continue;
    await act("sales.commission_plan.create", {
      name: plan.name, payeePartyId, payeeKind: plan.payeeKind, defaultRatePct: plan.defaultRatePct, paymentDays: plan.paymentDays, validFrom: `${year}-01-01`,
      userIds: [await userId(plan.user)], lines: key === "employee" ? [{ categoryId: ground!.id, ratePct: COMMISSION_PLANS.employee.category.ratePct }] : [],
    });
  }
  const catering = await partyId(COMMISSION_SALE.party);
  let sold = await one(sql<{ id: string; stage: string }[]>`select id, stage from sales.orders where company_id = ${DEMO_COMPANY_ID} and notes = ${COMMISSION_SALE.notes} and status <> 'voided'`);
  if (!sold) {
    sold = (await act<{ id: string; stage: string }>("sales.order.create", { partyId: catering, warehouseId, issueDate: today, notes: COMMISSION_SALE.notes, lines: [{ productId: await product(COMMISSION_SALE.sku), qty: COMMISSION_SALE.qty }] }));
    sold = (await one(sql<{ id: string; stage: string }[]>`select id, stage from sales.orders where id = ${sold.id}`))!;
  }
  if (sold.stage === "open") await act("sales.order.confirm", { id: sold.id });
  await drain();
  await shipOrder(sql, act, drain, sold.id, today, costCenter);
  let feCom = await chainInvoice(sql, sold.id);
  if (!feCom) {
    await act("invoicing.invoice.from_orders", { orderIds: [sold.id] });
    feCom = (await chainInvoice(sql, sold.id))!;
  }
  if (feCom.stage === "draft") {
    await act("invoicing.invoice.issue", { id: feCom.id, idempotencyKey: `demo-commission-issue-${feCom.id}`, notes: COMMISSION_SALE.notes });
    feCom = (await chainInvoice(sql, sold.id))!;
  }
  await drain();
  if (feCom.dian_status !== "accepted") {
    await mockDianAccepts(sql, deps, store, feCom.id);
    chains.add((await one(sql<{ chain_id: string }[]>`select chain_id from kernel.outbox where company_id = ${DEMO_COMPANY_ID} and event = 'invoicing.invoice.issued' and payload->>'invoiceId' = ${feCom.id} order by created_at desc limit 1`))!.chain_id);
    await drain();
  }
  const [{ n: received }] = (await sql<{ n: number }[]>`
    select count(distinct r.id)::int as n from payments.receipts r join payments.receipt_allocations a on a.receipt_id = r.id
    where r.company_id = ${DEMO_COMPANY_ID} and a.invoice_id = ${feCom.id} and r.status <> 'voided'`) as [{ n: number }];
  for (const [i, amount] of COMMISSION_SALE.receipts.entries()) {
    if (i < received) continue;
    await act("payments.payment.receive", {
      partyId: catering, methodId: methodIds.TRF, amount, date: today, reference: `${COMMISSION_SALE.reference}-${i + 1}`,
      allocations: [{ invoiceId: feCom.id, amount }], idempotencyKey: `demo-commission-receipt-${feCom.id}-${i + 1}`,
    });
    await drain();
  }

  // 12 (first half). Bodega: enabled now (so the pedidos above have no alistamiento), its bins and put-away rules.
  await enableModule(sql, DEMO_COMPANY_ID, "warehouse", deps.registry);
  const categoryId = async (name: string) => (await one(sql<{ id: string }[]>`select id from core.product_categories where company_id = ${DEMO_COMPANY_ID} and name = ${name}`))!.id;
  const bins: Record<string, string> = {};
  for (const bin of BINS) {
    const found = await one(sql<{ id: string }[]>`select id from inventory.locations where company_id = ${DEMO_COMPANY_ID} and warehouse_id = ${warehouseId} and code = ${bin.code}`);
    bins[bin.code] = found?.id ?? (await act("inventory.location.create", { warehouseId, code: bin.code, name: bin.name })).id;
    const category = await categoryId(bin.category);
    if (!(await one(sql`select 1 from warehouse.putaway_rules where company_id = ${DEMO_COMPANY_ID} and warehouse_id = ${warehouseId} and category_id = ${category} and location_id = ${bins[bin.code]!}`))) {
      await act("warehouse.putaway_rule.create", { warehouseId, categoryId: category, locationId: bins[bin.code]!, priority: RULE_PRIORITY });
    }
  }

  // 11 (second half) and 12. The entrega that leaves by FEFO in two lots, picked first (Bodega), invoiced as a Borrador (its line carries both lots).
  let lotOrder = await one(sql<{ id: string; stage: string }[]>`select id, stage from sales.orders where company_id = ${DEMO_COMPANY_ID} and notes = ${LOT_SALE.notes} and status <> 'voided'`);
  if (!lotOrder) {
    const created = await act<{ id: string }>("sales.order.create", { partyId: await partyId(LOT_SALE.party), warehouseId, issueDate: today, notes: LOT_SALE.notes, lines: [{ productId: await product(LOT_PRODUCT.sku), qty: LOT_SALE.qty }] });
    lotOrder = (await one(sql<{ id: string; stage: string }[]>`select id, stage from sales.orders where id = ${created.id}`))!;
  }
  if (lotOrder.stage === "open") await act("sales.order.confirm", { id: lotOrder.id });
  await drain();
  // The alistamiento Bodega made on the confirmation, confirmed as proposed (FEFO); the allocation answers and sales makes the Borrador entrega.
  const pick = await one(sql<{ id: string; stage: string }[]>`select id, stage from warehouse.picks where company_id = ${DEMO_COMPANY_ID} and order_id = ${lotOrder.id} and status <> 'voided'`);
  if (!pick) throw new Error("demo sale chain: the FEFO pedido has no alistamiento");
  if (pick.stage !== "confirmed") await act("warehouse.pick.confirm", { id: pick.id });
  await drain();
  await shipOrder(sql, act, drain, lotOrder.id, today, costCenter);
  // Packed in one box and closed.
  let pack = await one(sql<{ id: string; stage: string }[]>`select id, stage from warehouse.packs where company_id = ${DEMO_COMPANY_ID} and pick_id = ${pick.id} and status <> 'voided'`);
  if (!pack) {
    const created = await act<{ id: string }>("warehouse.pack.create", { pickId: pick.id });
    pack = (await one(sql<{ id: string; stage: string }[]>`select id, stage from warehouse.packs where id = ${created.id}`))!;
  }
  if (pack.stage !== "closed") {
    const boxes = await sql<{ package_no: number; items: { pickLineId: string; qty: number }[] }[]>`select package_no, items from warehouse.pack_packages where pack_id = ${pack.id} order by package_no`;
    await act("warehouse.pack.update", { id: pack.id, packages: boxes.map((b) => ({ packageNo: b.package_no, weightKg: PACK.weightKg, dimensions: PACK.dimensions, lines: b.items })) });
    await act("warehouse.pack.close", { id: pack.id });
  }
  if (!(await chainInvoice(sql, lotOrder.id))) await act("invoicing.invoice.from_orders", { orderIds: [lotOrder.id] });
  await drain();

  // 12 (second half). A receipt at Estantería A, put away to its category's bin as suggested; inventory relocates it.
  let putawayReceipt = await one(sql<{ id: string }[]>`select id from inventory.movements where company_id = ${DEMO_COMPANY_ID} and reference = ${PUTAWAY_RECEIPT.reference} and status <> 'voided'`);
  if (!putawayReceipt) {
    putawayReceipt = await act<{ id: string }>("inventory.movement.post", {
      kind: "receipt", date: today, warehouseId, reference: PUTAWAY_RECEIPT.reference, description: "Entrada de café en grano por ubicar",
      lines: [{ productId: await product(PUTAWAY_RECEIPT.sku), locationId: location!.id, qty: PUTAWAY_RECEIPT.qty, unitCost: await standardCost(PUTAWAY_RECEIPT.sku) }],
    });
    await drain();
  }
  const suggestion = await act<{ lines: { productId: string; lotId: string | null; serialId: string | null; qty: number; fromLocationId: string | null; toLocationId: string | null }[] }>(
    "warehouse.putaway.suggest", { movementId: putawayReceipt.id });
  const toPut = suggestion.lines.filter((l) => l.toLocationId);
  if (toPut.length > 0) {
    await act("warehouse.putaway.confirm", { movementId: putawayReceipt.id, lines: toPut.map((l) => ({ productId: l.productId, lotId: l.lotId, serialId: l.serialId, qty: l.qty, fromLocationId: l.fromLocationId, toLocationId: l.toLocationId! })) });
    await drain();
  }

  const [paid] = await sql<{ stage: string }[]>`select stage from invoicing.invoices where id = ${invoice.id}`;
  if (paid!.stage !== "paid") throw new Error(`demo sale chain: the invoice ${invoice.number} is ${paid!.stage}, not paid`);
  return {
    actions,
    chain: { quote: quote.number, order: order.number, delivery: deliveryId, invoice: invoice.number, receipt: receipt.number },
    foreign: { invoice: feUsd.number, receipt: usdReceipt.number },
  };
}

type Act = <T = { id: string }>(processId: string, input: unknown, options?: { stepUp?: boolean; ui?: boolean }) => Promise<T>;

/** The order's entrega, created and shipped when missing (its consumers move the stock and post the cost of sales); answers its number. */
async function shipOrder(sql: Sql, act: Act, drain: () => Promise<void>, orderId: string, today: string, costCenterId: string): Promise<string> {
  let delivery = await one(sql<{ id: string; number: string; stage: string }[]>`select id, number, stage from sales.deliveries where company_id = ${DEMO_COMPANY_ID} and order_id = ${orderId} and status <> 'voided'`);
  if (!delivery) {
    const created = await act<{ id: string }>("sales.delivery.create", { orderId, date: today, costCenterId });
    delivery = (await one(sql<{ id: string; number: string; stage: string }[]>`select id, number, stage from sales.deliveries where id = ${created.id}`))!;
  }
  if (delivery.stage !== "shipped") await act("sales.delivery.ship", { id: delivery.id });
  await drain();
  return delivery.number;
}

async function chainInvoice(sql: Sql, orderId: string) {
  return one(sql<{ id: string; number: string | null; stage: string; dian_status: string }[]>`
    select distinct i.id, i.number, i.stage, i.dian_status from invoicing.invoices i join invoicing.invoice_lines l on l.invoice_id = i.id
    where i.company_id = ${DEMO_COMPANY_ID} and l.order_id = ${orderId} and i.stage <> 'voided'`);
}

/**
 * The MOCK DIAN accepts the issued invoice: the submission requested as invoicing's consumer of the issued event does, claimed, its
 * (placeholder) signed document and the DIAN's ApplicationResponse kept in the file store, sent, and the verdict recorded by
 * invoicing.invoice.dian_result: the processes of the e-invoice workflow (Task 17), on the issued event's chain; only the signing and the
 * transport are left out (no certificate in the demo). The issued row's invoicing delivery is then recorded, the consumer's work being done.
 */
async function mockDianAccepts(sql: Sql, deps: RunProcessDeps, store: FileStore | null, invoiceId: string): Promise<void> {
  const [row] = await sql<Row[]>`
    select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${DEMO_COMPANY_ID} and event = 'invoicing.invoice.issued' and payload->>'invoiceId' = ${invoiceId} order by created_at desc limit 1`;
  if (!row) throw new Error(`demo sale chain: no invoicing.invoice.issued for ${invoiceId}`);
  const ctx = buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId: DEMO_COMPANY_ID, chainId: row.chain_id }, deps.registry);
  const requested = (await ctx.runProcess("invoicing.einvoice_submission.request", { invoiceId })) as { submissionId: string };
  const runId = `demo-mock-${randomUUID()}`;
  const claimed = (await ctx.runProcess("invoicing.einvoice_submission.record", { action: "claim", id: requested.submissionId, runId })) as { owned: boolean; submission: { round: number } };
  if (!claimed.owned) throw new Error(`demo sale chain: the submission ${requested.submissionId} is not waiting to be sent`);
  const [company] = await sql<{ tenant_id: string }[]>`select tenant_id from kernel.companies where id = ${DEMO_COMPANY_ID}`;
  const dir = `${company!.tenant_id}/${DEMO_COMPANY_ID}/einvoice/${invoiceId}/r${claimed.submission.round}-${runId}`;
  const xmlPath = `${dir}/documento.xml`;
  const responsePath = `${dir}/respuesta-dian.xml`;
  if (store) {
    await store.put(xmlPath, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- Documento de demostración (DIAN simulada, habilitación): sin firma ni validez fiscal. -->\n<Invoice/>\n`), "application/xml");
    await store.put(responsePath, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- Respuesta de la DIAN simulada (demostración) -->\n<ApplicationResponse><ResponseCode>02</ResponseCode></ApplicationResponse>\n`), "application/xml");
  }
  await ctx.runProcess("invoicing.einvoice_submission.record", { action: "submitting", id: requested.submissionId, runId, xmlPath });
  await ctx.runProcess("invoicing.einvoice_submission.record", { action: "submitted", id: requested.submissionId, runId, trackId: `demo-mock-${invoiceId.slice(0, 8)}-${claimed.submission.round}` });
  await ctx.runProcess("invoicing.invoice.dian_result", { id: invoiceId, submissionId: requested.submissionId, runId, status: "accepted", errors: [], xmlPath, responsePath });
  await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, 'invoicing') on conflict do nothing`;
}

/** What each demo role may do in the sale chain besides its consults (the role defaults give every role the consults of the modules). */
export function salesGrants(processIds: string[]): { roleId: string; processId: string }[] {
  const sells = processIds.filter((id) =>
    /^crm\.(lead|opportunity|activity|quote)\.(create|update|convert|stage_move|send|accept|expire)$/.test(id) ||
    /^sales\.(order\.(create|update|from_quote|confirm|cancel|reassign)|delivery\.(create|update|ship)|return\.(create|receive)|price\.resolve|discount\.resolve)$/.test(id) ||
    /^invoicing\.(invoice\.(from_orders|create|update|issue)|pending_line\.list)$/.test(id));
  const collects = processIds.filter((id) => /^payments\.payment\.(receive|open_invoices)$/.test(id));
  // The accountant bills (issues invoices): it sees every pedido (sales.order.reassign, the «all orders» permission of Task 39, R39-7).
  const accountant = processIds.filter((id) => /^invoicing\.(invoice\.(issue|resubmit)|note\.(create|issue))$/.test(id) || /^payments\.payment\.(receive|open_invoices)$/.test(id) || id === "sales.order.reassign");
  // Commissions (Task 30.4, owner item 167): who sees every salesperson's commissions (sales.commission.consult_all); the plans are the
  // gerente comercial's to write.
  const commissions = processIds.filter((id) => id === "sales.commission.consult_all");
  const plans = processIds.filter((id) => /^sales\.commission_plan\.(create|update)$/.test(id));
  // Bodega (Task 29.4): the gerente comercial picks, packs and puts away.
  const warehouse = processIds.filter((id) => /^warehouse\.(pick\.(create|start|update|confirm)|pack\.(create|update|close)|putaway\.confirm)$/.test(id));
  return [
    ...sells.map((processId) => ({ roleId: DEMO_ROLE_IDS.gerente_comercial, processId })),
    ...[...commissions, ...plans, ...warehouse].map((processId) => ({ roleId: DEMO_ROLE_IDS.gerente_comercial, processId })),
    ...commissions.map((processId) => ({ roleId: DEMO_ROLE_IDS.contador, processId })),
    ...commissions.map((processId) => ({ roleId: DEMO_ROLE_IDS.admin, processId })),
    ...collects.map((processId) => ({ roleId: DEMO_ROLE_IDS.cajero, processId })),
    ...accountant.map((processId) => ({ roleId: DEMO_ROLE_IDS.contador, processId })),
  ];
}

async function grantSales(sql: Sql, act: Act): Promise<void> {
  const registered = (await sql<{ process_id: string }[]>`select process_id from kernel.registered_processes where module_id = any(${[...SALES_CHAIN_MODULES]}::text[])`).map((r) => r.process_id);
  const granted = new Set((await sql<{ role_id: string; process_id: string }[]>`
    select role_id, process_id from kernel.process_permissions where company_id = ${DEMO_COMPANY_ID} and allowed`).map((r) => `${r.role_id}|${r.process_id}`));
  const changes = salesGrants(registered).filter((g) => !granted.has(`${g.roleId}|${g.processId}`)).map((g) => ({ ...g, allowed: true }));
  if (changes.length > 0) await act("kernel.admin.permission.set_many", { changes }, { stepUp: true });
}
