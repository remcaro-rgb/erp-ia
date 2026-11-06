import { randomUUID } from "node:crypto";
import { buildConsumerContext, kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, type Caller, type ConsumerContext, type RunProcessDeps } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { core } from "@erp/module-core";
import { sales } from "@erp/module-sales";
import { crm } from "../index";

export type Db = ReturnType<typeof testDb>;

const registry = new Registry();
loadModules(registry, [kernelModule, core, sales, crm]);

/** Every process of core, sales and crm as the loader registers them (the generic lifecycle ones included). */
const PROCESS_IDS = [...registry.processes({ module: "core" }), ...registry.processes({ module: "sales" }), ...registry.processes({ module: "crm" })].map((p) => p.id);

/** Every crm table, children first. */
export const CRM_TABLES = ["activities", "quote_lines", "quotes", "settings", "opportunity_lines", "opportunities", "stages", "pipelines", "leads", "document_numbers"];
/** Every sales table. */
export const SALES_TABLES = ["order_lines", "orders", "document_numbers", "customer_terms", "settings"];

export interface CrmHarness {
  sql: Db;
  deps: RunProcessDeps;
  registry: Registry;
  seed: SeededTenant;
  /** Admin of company 0 (user `both`). */
  admin: Caller;
  /** A salesperson of company 0: every crm process but crm.opportunity.reassign and the approval of cotizaciones (crm.quote.approve /
   * reject), so a salesperson never approves their own discount. */
  vendedor: Caller;
  /** A second salesperson of company 0 with the same role. */
  vendedora: Caller;
  /** An approver of company 0: crm.quote.approve, crm.quote.reject and the quote consults only (not crm.opportunity.reassign). */
  aprobadora: Caller;
  /** Admin of company 1. */
  other: Caller;
  companyId: string;
  otherCompanyId: string;
  run: <T = unknown>(caller: Caller, processId: string, input: unknown) => Promise<T>;
  /** An event consumer's context for company 0 (origin `event`, system user), as the outbox drain builds it. */
  consumer: (event?: string) => ConsumerContext;
  cleanup: () => Promise<void>;
}

/** Seeds two companies entitled to core, sales and crm, grants their admins every core and crm process, registers the manifests. */
export async function crmHarness(): Promise<CrmHarness> {
  const sql = testDb();
  registerCountryPack(co);
  await syncModuleManifest(sql, core);
  await syncModuleManifest(sql, sales);
  await syncModuleManifest(sql, crm);
  const seed = await seedTenant(sql, {
    companies: 2,
    users: [
      { name: "vendedor", companies: [0], role: "member" },
      { name: "vendedora", companies: [0], role: "member" },
      { name: "aprobadora", companies: [0], role: "member" },
    ],
    entitlements: ["module:core", "module:sales", "module:crm"],
  });
  for (const company of seed.companies) {
    for (const id of PROCESS_IDS) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
                values (${company.id}, ${company.adminRoleId}, ${id}) on conflict (company_id, role_id, process_id) do nothing`;
    }
  }
  const companyId = seed.companies[0]!.id;
  const [salesRole] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'vendedor', false) returning id`;
  await seed.holdRoles(seed.users.vendedor!, companyId, [salesRole!.id]);
  await seed.holdRoles(seed.users.vendedora!, companyId, [salesRole!.id]);
  const approvals = new Set(["crm.opportunity.reassign", "crm.quote.approve", "crm.quote.reject"]);
  for (const id of PROCESS_IDS.filter((p) => p.startsWith("crm.") && !approvals.has(p))) {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${salesRole!.id}, ${id}) on conflict do nothing`;
  }
  const [approverRole] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'aprobador', false) returning id`;
  await seed.holdRoles(seed.users.aprobadora!, companyId, [approverRole!.id]);
  for (const id of ["crm.quote.approve", "crm.quote.reject", "crm.quote.consult", "crm.quote_line.consult"]) {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${approverRole!.id}, ${id}) on conflict do nothing`;
  }
  const otherCompanyId = seed.companies[1]!.id;
  const companyIds = [companyId, otherCompanyId];
  const deps = { sql, registry };
  const asUser = (user: string, role: string): Caller => ({ claims: { ...seed.claimsFor(seed.users[user]!, companyId), role_ids: [role] } as JwtClaims, origin: "ui" });
  return {
    sql,
    deps,
    registry,
    seed,
    admin: { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" },
    vendedor: asUser("vendedor", salesRole!.id),
    vendedora: asUser("vendedora", salesRole!.id),
    aprobadora: asUser("aprobadora", approverRole!.id),
    other: { claims: seed.claimsFor(seed.users.both, otherCompanyId) as JwtClaims, origin: "ui" },
    companyId,
    otherCompanyId,
    run: <T>(c: Caller, processId: string, input: unknown) => runProcess(deps, c, processId, input) as Promise<T>,
    consumer: (event = "sales.order.confirmed") => buildConsumerContext(sql, { id: randomUUID(), event, companyId, chainId: randomUUID(), createdAt: new Date() }, registry),
    async cleanup() {
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        for (const table of CRM_TABLES) await tx`delete from ${tx(`crm.${table}`)} where company_id = any(${companyIds}::uuid[])`;
        for (const table of SALES_TABLES) await tx`delete from ${tx(`sales.${table}`)} where company_id = any(${companyIds}::uuid[])`;
        for (const table of ["price_list_items", "price_lists", "party_contacts", "products", "product_categories", "parties", "document_sequences", "entity_sequences"]) {
          await tx`delete from ${tx(`core.${table}`)} where company_id = any(${companyIds}::uuid[])`;
        }
      });
      await sql`delete from kernel.export_jobs where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
      await sql`delete from kernel.record_snapshots where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
      await sql`delete from kernel.field_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
      await seed.cleanup();
      await sql.end();
    },
  };
}

/** A customer prospect (crm.lead.create input) with the document data convert needs. */
export const prospect = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  contactName: "Laura Pérez",
  email: "compras@cafedelnorte.example",
  source: "referral",
  personType: "1",
  documentType: "31",
  documentNumber: "900373115",
  ...overrides,
});

/** The standard embudo as crm.pipeline.create takes it. */
export const salesPipeline = (code = "VENTAS") => ({
  code,
  name: `Embudo ${code}`,
  stages: [
    { name: "Nuevo", probability: 10, kind: "open" },
    { name: "Propuesta", probability: 60, kind: "open" },
    { name: "Ganada", probability: 100, kind: "won" },
    { name: "Perdida", probability: 0, kind: "lost" },
  ],
});

/** A stocked good (core.product.create input) with SKU `sku`. */
export const good = (sku: string) => ({
  sku, description: `Café ${sku}`, kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, standardCost: 16200, trackStock: true,
});

export const newId = () => randomUUID();
