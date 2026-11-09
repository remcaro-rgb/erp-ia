import type { Sql } from "postgres";
import { SYSTEM_USER_ID, type JwtClaims } from "../db/client";
import { runProcess } from "../process/run";
import { registry as defaultRegistry, type Registry } from "../registry";
import type { ConsumerContext, EventConsumer } from "../registry/types";

export type { ConsumerContext, EventConsumer };

/**
 * Actor of every process an event consumer runs; audit rows of `event` origin carry it. Defined in db/client (withClaims refuses it
 * unless allowed, plan 2B Task 52.3), re-exported here where its callers import it.
 */
export { SYSTEM_USER_ID };

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

  /**
   * The consumers of `event`, one per module: the event's own first, then the `"*"` consumers of the modules that have
   * none for this event.
   */
  for(event: string): Array<{ moduleId: string; fn: EventConsumer }> {
    const own = this.byEvent.get(event) ?? [];
    if (event === "*") return [...own];
    const taken = new Set(own.map((c) => c.moduleId));
    return [...own, ...(this.byEvent.get("*") ?? []).filter((c) => !taken.has(c.moduleId))];
  }

  /** True when `moduleId` consumes `event` only through its `"*"` consumer (it has none of its own for the event). */
  isWildcard(event: string, moduleId: string): boolean {
    return event !== "*" && !(this.byEvent.get(event) ?? []).some((c) => c.moduleId === moduleId);
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
  id?: string;
  event?: string;
  createdAt?: Date;
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
    event: { id: row.id ?? "", name: row.event ?? "", createdAt: row.createdAt ?? new Date() },
    async runProcess(processId, input) {
      return runProcess({ sql, registry }, { claims: await systemClaims(), origin: "event", chainId: row.chainId }, processId, input);
    },
  };
}
