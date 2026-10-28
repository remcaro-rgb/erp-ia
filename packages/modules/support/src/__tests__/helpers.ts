import { kernelModule, loadModules, Registry, type Caller, type RunProcessDeps } from "@erp/kernel";
import { seedTenant, testDb, type SeededTenant } from "@erp/kernel/testing";
import { support } from "../index";

export type Db = ReturnType<typeof testDb>;

/** Every permission the three test roles hold: a reporter files and follows up, an agent answers and closes. */
export const REPORTER_PROCESSES = ["support.ticket.create", "support.ticket.consult", "support.ticket.reply"];
export const AGENT_PROCESSES = ["support.ticket.consult", "support.ticket.reply", "support.ticket.close", "support.ticket_message.consult"];
/** The plain reporter of the brief: files tickets and reads them, nothing else. */
export const PLAIN_PROCESSES = ["support.ticket.create", "support.ticket.consult"];

export interface SupportHarness {
  sql: Db;
  deps: RunProcessDeps;
  seed: SeededTenant;
  companyId: string;
  otherCompanyId: string;
  /** Roles of company 0 and the agent role of company 1. */
  roles: { reporter: string; plain: string; agent: string; agentOther: string };
  /** Callers of company 0: two reporters, a plain reporter and an agent; `agentOther` is an agent active in company 1. */
  reporterA: Caller;
  reporterB: Caller;
  plain: Caller;
  agent: Caller;
  agentOther: Caller;
  cleanup: () => Promise<void>;
}

/**
 * Seeds a tenant entitled to `module:support` with two companies and the roles of the support tests, and
 * loads the support module into a fresh registry. The roles are only claims here: the permission matrix is
 * what the processes and the row policies read.
 */
export async function supportHarness(): Promise<SupportHarness> {
  const sql = testDb();
  const registry = new Registry();
  loadModules(registry, [kernelModule, support]);
  const seed = await seedTenant(sql, {
    companies: 2,
    entitlements: ["module:support"],
    users: [
      { name: "reporterA", companies: [0], role: "member" },
      { name: "reporterB", companies: [0], role: "member" },
      { name: "plain", companies: [0], role: "member" },
      { name: "agent", companies: [0, 1], role: "member" },
    ],
  });
  const [company, other] = seed.companies;
  const role = async (companyId: string, name: string, processes: string[]) => {
    const [row] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, ${name}) returning id`;
    for (const process of processes) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${row!.id}, ${process})`;
    }
    return row!.id;
  };
  const roles = {
    reporter: await role(company!.id, "reporter", REPORTER_PROCESSES),
    plain: await role(company!.id, "plain_reporter", PLAIN_PROCESSES),
    agent: await role(company!.id, "support_agent", AGENT_PROCESSES),
    agentOther: await role(other!.id, "support_agent", AGENT_PROCESSES),
  };
  const caller = (user: string, companyId: string, roleId: string): Caller => ({
    claims: { ...seed.claimsFor(seed.users[user]!, companyId), role_ids: [roleId] },
    origin: "ui",
  });
  return {
    sql,
    deps: { sql, registry },
    seed,
    companyId: company!.id,
    otherCompanyId: other!.id,
    roles,
    reporterA: caller("reporterA", company!.id, roles.reporter),
    reporterB: caller("reporterB", company!.id, roles.reporter),
    plain: caller("plain", company!.id, roles.plain),
    agent: caller("agent", company!.id, roles.agent),
    agentOther: caller("agent", other!.id, roles.agentOther),
    async cleanup() {
      const companyIds = seed.companies.map((c) => c.id);
      for (const table of ["ticket_messages", "tickets"]) {
        await sql`delete from ${sql(`support.${table}`)} where company_id = any(${companyIds}::uuid[])`;
      }
      await sql`delete from core.entity_sequences where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.field_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
      await seed.cleanup();
      await sql.end();
    },
  };
}
