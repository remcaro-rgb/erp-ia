import { randomUUID } from "node:crypto";
import { ATTACHMENT_PROCESSES, CUSTOM_FIELD_PROCESSES, HELP_PROCESSES, kernelModule, loadModules, registerCountryPack, registry, type Caller, type RunProcessDeps } from "@erp/kernel";
import { seedTenant, testDb, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";

// The agent's integration harness: a tenant whose company is "Café del Norte", the app's modules in the global
// registry (the one the workflow steps resolve processes from, as in the web app), an admin who may run every core,
// support and help process, and a cashier who may only consult parties.

export type Db = ReturnType<typeof testDb>;

export const ADMIN_PROCESSES = [
  ...core.processes.map((p) => p.id),
  ...ATTACHMENT_PROCESSES.map((p) => p.id),
  ...CUSTOM_FIELD_PROCESSES.map((p) => p.id),
  ...HELP_PROCESSES.map((p) => p.id),
  ...support.processes.map((p) => p.id),
  "kernel.data.query",
  "kernel.export.run",
  "kernel.import.run",
  "kernel.import.preview",
];
export const CASHIER_PROCESSES = ["core.party.consult", "kernel.data.query"];

export interface AgentHarness {
  sql: Db;
  deps: RunProcessDeps;
  seed: SeededTenant;
  tenantId: string;
  companyId: string;
  /** The system admin of the company (user `both`). */
  admin: Caller;
  /** A member whose only role ("cajero") consults parties. */
  cashier: Caller;
  cashierRoleId: string;
  /** Another admin of the same company (user `other`). */
  otherAdmin: Caller;
  /** A conversation of `user` in the company, created with the service role. */
  conversation: (caller: Caller) => Promise<string>;
  cleanup: () => Promise<void>;
}

/** Loads the app's modules into the global registry once (the steps of a workflow read it). */
export function loadAppModules(): void {
  if (!registry.hasModule(kernelModule.id)) loadModules(registry, [kernelModule, core, support]);
  registerCountryPack(co);
}

export async function agentHarness(options: { entitlements?: string[] } = {}): Promise<AgentHarness> {
  loadAppModules();
  const sql = testDb();
  const seed = await seedTenant(sql, {
    companies: 1,
    entitlements: options.entitlements ?? ["module:core", "module:support"],
    users: [
      { name: "cashier", companies: [0], role: "member" },
      { name: "other", companies: [0] },
    ],
  });
  const company = seed.companies[0]!;
  await sql`update kernel.companies set legal_name = 'Café del Norte S.A.S.', tax_id = '900373115' where id = ${company.id}`;
  await sql`update kernel.users set full_name = 'Ana Gómez' where id = ${seed.users.both}`;
  for (const id of ADMIN_PROCESSES) {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.adminRoleId}, ${id}) on conflict do nothing`;
  }
  const [cashierRole] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${company.id}, ${`cajero ${randomUUID().slice(0, 4)}`}) returning id`;
  for (const id of CASHIER_PROCESSES) {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${cashierRole!.id}, ${id})`;
  }
  // The cashier holds the cashier role (0024: kernel.current_role_ids() counts only the claim's roles the user holds).
  await seed.holdRoles(seed.users.cashier!, company.id, [cashierRole!.id]);
  const caller = (user: string, roleId?: string): Caller => {
    const claims = seed.claimsFor(seed.users[user]!, company.id);
    return { claims: roleId ? { ...claims, role_ids: [roleId] } : claims, origin: "ui" };
  };
  const companyIds = [company.id];
  return {
    sql,
    deps: { sql, registry },
    seed,
    tenantId: seed.tenantId,
    companyId: company.id,
    admin: caller("both"),
    cashier: caller("cashier", cashierRole!.id),
    cashierRoleId: cashierRole!.id,
    otherAdmin: caller("other"),
    async conversation(c) {
      const [row] = await sql<{ id: string }[]>`
        insert into kernel.agent_conversations(company_id, user_id, title) values (${c.claims.active_company_id}, ${c.claims.sub}, 'Prueba') returning id`;
      return row!.id;
    },
    async cleanup() {
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        for (const table of ["core.party_contacts", "core.parties", "core.entity_sequences", "support.ticket_messages", "support.tickets"]) {
          await tx`delete from ${tx(table)} where company_id = any(${companyIds}::uuid[])`;
        }
      });
      await sql`delete from kernel.llm_usage where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.agent_conversations where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.model_policies where tenant_id = ${seed.tenantId}`;
      await sql`delete from kernel.field_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.sensitive_processes where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
      await seed.cleanup();
      await sql.end();
    },
  };
}

/** The real `core.party.create` input of a Colombian juridical customer (document number without DV). */
export const exito = {
  kind: ["customer"],
  personType: "1",
  documentType: "31",
  documentNumber: "900373115",
  legalName: "Éxito",
  taxResponsibilities: ["R-99-PN"],
  taxScheme: "ZZ",
  countryCode: "CO",
};
