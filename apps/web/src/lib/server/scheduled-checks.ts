import "server-only";
import { postingAgePlan } from "@erp/module-accounting";
import { moduleGate, runProcess, SYSTEM_USER_ID, withClaims, type Caller, type JwtClaims, type RunProcessDeps } from "@erp/kernel";

// The scheduled checks of the outbox tick (plan 2B.2 Task 52.7, owner item 74, ruling R52-6). The drain belongs to the kernel, which may
// not name a module (rule 4); the tick route, the app's composition root, runs these after the drain, each in its own try/catch. A check is
// a registered process (rule 1) run once per company with origin `scheduler` as the kernel's system user holding the company's system
// admin role (allowed for that origin, Task 52.3), exactly as an event consumer runs its processes. Today: the age alert of the
// asynchronous posting mode. Fix round 1 (item 107): a company is checked at most once a minute, and its process runs (and writes its
// audit row) only when a cheap read through the published views says there is something to raise or close. Cost if wrong: a generic scheduled-process registry in the kernel later (phase 3's scheduler table); the
// work is the same loop.

/** The posting age alert of accounting's asynchronous mode. */
export const POSTING_AGE_CHECK = "accounting.posting.age_check";
/** A company is checked at most once in this window (the worker ticks every 30 s; the shortest threshold is 5 minutes). */
export const CHECK_INTERVAL_MS = 60_000;

export interface ScheduledChecks {
  /** The companies to check. */
  companies: () => Promise<string[]>;
  /** The system user's claims for the company. */
  claims: (companyId: string) => Promise<JwtClaims>;
  /**
   * Whether the check has something to do for the caller's company (fix round 1, item 107): a cheap read, no process and no audit row.
   * Only then is `run` called.
   */
  due: (caller: Caller) => Promise<boolean>;
  run: (caller: Caller, processId: string, input: unknown) => Promise<unknown>;
}

/**
 * The production wiring over the service connection: the companies with accounting enabled that post asynchronously, plus those with an
 * open `posting_age` recommendation (switched back to inline strict: the check closes it).
 */
export function scheduledChecks(deps: RunProcessDeps): ScheduledChecks {
  const { sql } = deps;
  return {
    async companies() {
      const rows = await sql<{ company_id: string }[]>`
        select m.company_id from accounting.v_posting_mode m where m.posting_mode = 'asynchronous'
        union
        -- The raw kernel table, on purpose: this list spans every company, and the published kernel.v_recommendations answers only for
        -- the caller's active company and audience (a service connection has neither). Company ids only, nothing a user reads.
        select r.company_id from kernel.recommendations r
        where r.source = 'process' and r.module = 'accounting' and r.reason = 'posting_age' and r.status = 'new'`;
      const enabled: string[] = [];
      for (const { company_id } of rows) if ((await moduleGate(sql, company_id, "accounting")) === "enabled") enabled.push(company_id);
      return enabled;
    },
    async claims(companyId) {
      const [company] = await sql<{ tenant_id: string }[]>`select tenant_id from kernel.companies where id = ${companyId}`;
      const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and is_system and name = 'admin'`;
      if (!company) throw new Error(`company ${companyId} not found`);
      if (!role) throw new Error(`company ${companyId} has no system admin role`);
      return { sub: SYSTEM_USER_ID, tenant_id: company.tenant_id, company_ids: [companyId], active_company_id: companyId, role_ids: [role.id], locale: "es-419" };
    },
    // The same answer the process acts on (accounting's postingAgePlan), read as the system user through the published views.
    async due(caller) {
      const known = (entity: string) => {
        try {
          deps.registry.entity(entity);
          return true;
        } catch {
          return false;
        }
      };
      const plan = await withClaims(sql, caller.claims, (tx) => postingAgePlan(tx, caller.claims.active_company_id, known), { allowSystem: true });
      return plan.raise.length > 0 || plan.close.length > 0;
    },
    run: (caller, processId, input) => runProcess(deps, caller, processId, input),
  };
}

export interface ScheduledChecksOptions {
  now?: () => number;
  /** When each company was last checked (ms); the module's own map by default, so the throttle lasts as long as the server process. */
  lastRun?: Map<string, number>;
}

const LAST_RUN_KEY = Symbol.for("erp.web.scheduledChecksLastRun");
const lastRunGlobals = globalThis as { [LAST_RUN_KEY]?: Map<string, number> };

/**
 * Runs the checks per company: a company checked less than CHECK_INTERVAL_MS ago is skipped; otherwise `due` is asked and the process
 * runs only when it answers true. A company that fails is logged and the next one runs. Answers how many ran and failed.
 */
export async function runScheduledChecks(checks: ScheduledChecks, options: ScheduledChecksOptions = {}): Promise<{ checked: number; failed: number }> {
  const now = options.now ?? Date.now;
  const lastRun = options.lastRun ?? (lastRunGlobals[LAST_RUN_KEY] ??= new Map());
  let companies: string[];
  try {
    companies = await checks.companies();
  } catch (error) {
    console.error("scheduled checks: listing the companies failed", error);
    return { checked: 0, failed: 0 };
  }
  let checked = 0;
  let failed = 0;
  for (const companyId of companies) {
    const last = lastRun.get(companyId);
    if (last !== undefined && now() - last < CHECK_INTERVAL_MS) continue;
    lastRun.set(companyId, now());
    try {
      const caller: Caller = { claims: await checks.claims(companyId), origin: "scheduler" };
      if (!(await checks.due(caller))) continue;
      await checks.run(caller, POSTING_AGE_CHECK, {});
      checked += 1;
    } catch (error) {
      failed += 1;
      console.error(`scheduled checks: ${POSTING_AGE_CHECK} failed for company ${companyId}`, error);
    }
  }
  return { checked, failed };
}

/** The tick: the drain, then the checks, each in its own try/catch; the answer is the drain's alone (`ok: false` when it failed). */
export async function tickWithChecks<T>(drain: () => Promise<T>, checks: () => Promise<unknown>): Promise<{ ok: true; result: T } | { ok: false }> {
  let outcome: { ok: true; result: T } | { ok: false };
  try {
    outcome = { ok: true, result: await drain() };
  } catch (error) {
    console.error("outbox tick failed", error);
    outcome = { ok: false };
  }
  try {
    await checks();
  } catch (error) {
    console.error("scheduled checks failed", error);
  }
  return outcome;
}
