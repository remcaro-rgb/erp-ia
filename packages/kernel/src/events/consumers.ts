import type { Sql } from "postgres";
import type { JwtClaims } from "../db/client";
import { runProcess } from "../process/run";
import { registry as defaultRegistry, type Registry } from "../registry";
import type { ConsumerContext, EventConsumer } from "../registry/types";

export type { ConsumerContext, EventConsumer };

/** Actor of every process an event consumer runs; audit rows of `event` origin carry it. */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

/** Event consumers per event, in registration order (design §5.5). */
export class ConsumerRegistry {
  private readonly byEvent = new Map<string, Array<{ moduleId: string; fn: EventConsumer }>>();

  /** One consumer per module and event: registering again replaces the module's previous one. */
  register(moduleId: string, event: string, fn: EventConsumer): void {
    const list = this.byEvent.get(event) ?? [];
    const at = list.findIndex((c) => c.moduleId === moduleId);
    if (at === -1) list.push({ moduleId, fn });
    else list[at] = { moduleId, fn };
    this.byEvent.set(event, list);
  }

  /** The consumers of `event`, one per module. */
  for(event: string): Array<{ moduleId: string; fn: EventConsumer }> {
    return [...(this.byEvent.get(event) ?? [])];
  }

  /** Every (event, module) pair registered; the outbox drain uses it to know which modules gate a row. */
  pairs(): Array<{ event: string; module_id: string }> {
    return [...this.byEvent].flatMap(([event, list]) => list.map((c) => ({ event, module_id: c.moduleId })));
  }
}

// Kept on globalThis: the workflow bundler may load this module twice in one process (app code and the
// generated step bundle), and a consumer registered through one copy must run through the other.
const GLOBAL_KEY = Symbol.for("erp.kernel.consumers");
const globals = globalThis as { [GLOBAL_KEY]?: ConsumerRegistry };

/** The process-wide registry `loadModules` fills and the dispatch workflow reads. */
export const consumers: ConsumerRegistry = (globals[GLOBAL_KEY] ??= new ConsumerRegistry());

export interface OutboxEnvelope {
  companyId: string;
  chainId: string;
}

/**
 * What a consumer of `row` receives. `runProcess` runs a registered process with origin `event`, on
 * the event's chain, as the system user holding the company's system admin role (the claims are read
 * with the service connection, on first use). The audit actor equals the claims' `sub`, so the
 * `actor_is_caller` policy holds. The system user holds no membership: `kernel.current_role_ids()` (0024) keeps its
 * claimed role as it is, on a service connection only.
 */
export function buildConsumerContext(sql: Sql, row: OutboxEnvelope, registry: Registry = defaultRegistry): ConsumerContext {
  let claims: Promise<JwtClaims> | undefined;
  const systemClaims = () =>
    (claims ??= (async () => {
      const [company] = await sql<{ tenant_id: string }[]>`select tenant_id from kernel.companies where id = ${row.companyId}`;
      const [role] = await sql<{ id: string }[]>`
        select id from kernel.roles where company_id = ${row.companyId} and is_system and name = 'admin'`;
      if (!company) throw new Error(`company ${row.companyId} not found`);
      if (!role) throw new Error(`company ${row.companyId} has no system admin role`);
      return {
        sub: SYSTEM_USER_ID,
        tenant_id: company.tenant_id,
        company_ids: [row.companyId],
        active_company_id: row.companyId,
        role_ids: [role.id],
        locale: "es-419",
      };
    })());

  return {
    sql,
    companyId: row.companyId,
    chainId: row.chainId,
    async runProcess(processId, input) {
      return runProcess({ sql, registry }, { claims: await systemClaims(), origin: "event", chainId: row.chainId }, processId, input);
    },
  };
}
