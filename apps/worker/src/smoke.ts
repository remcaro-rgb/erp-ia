import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

// End-to-end check of the Docker stack (design §21, Task 21): real workflows through the compose web app and the
// Workflow Postgres World, from outside the compose network (CI and `pnpm -F worker smoke`). It seeds its own tenant,
// so run it against a disposable stack (`docker compose down -v` afterwards).
//  1. An export job: a member signs in through the compose Auth, POST /api/export of 10,001 parties as CSV answers
//     202 { mode: "job" }; the `exportJobWorkflow` run is enqueued by the web app, delivered by the worker and runs
//     in the web app's flow route; the file lands in the compose Storage; GET /api/export/:jobId answers done.
//  2. The outbox: an event row is dispatched by the worker's 30 s tick (POST /api/internal/outbox/tick), which starts
//     a `dispatchOutboxRow` run on the same World.
// Both runs are then read from the Postgres World's own tables (`workflow.workflow_runs`).
//
// Environment (the values of .env.docker; the defaults are the compose's published host ports):
//   SMOKE_WEB_URL (http://127.0.0.1:56300), SMOKE_SUPABASE_URL (http://127.0.0.1:56321), SMOKE_DATABASE_URL
//   (postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:56322/postgres), ANON_KEY, SERVICE_ROLE_KEY, and
//   SUPABASE_INTERNAL_URL (http://kong:8000: the URL the web app knows Auth by, which names its session cookie).

const env = (name: string, fallback?: string): string => {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const WEB = env("SMOKE_WEB_URL", "http://127.0.0.1:56300");
const SUPABASE = env("SMOKE_SUPABASE_URL", "http://127.0.0.1:56321");
const INTERNAL_SUPABASE = env("SUPABASE_INTERNAL_URL", "http://kong:8000");
const ANON_KEY = env("ANON_KEY");
const SERVICE_ROLE_KEY = env("SERVICE_ROLE_KEY");
const DATABASE_URL = env("SMOKE_DATABASE_URL", `postgresql://postgres:${env("POSTGRES_PASSWORD")}@127.0.0.1:56322/postgres`);
const ROWS = 10_001;

const log = (message: string, extra?: unknown) => console.log(`[smoke] ${message}`, ...(extra === undefined ? [] : [JSON.stringify(extra)]));

/** fetch that sends what the web app addresses as http://kong:8000 to the compose's published port. */
const toHost = (input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(String(input instanceof Request ? input.url : input).replace(INTERNAL_SUPABASE, SUPABASE), init);

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function main(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  const admin = createClient(SUPABASE, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    // ---- a member of a fresh company who may consult parties and export ----
    const suffix = randomUUID().slice(0, 8);
    const email = `smoke-${suffix}@test.local`;
    const password = `pw-${randomUUID()}`;
    const [tenant] = await sql<{ id: string }[]>`insert into kernel.tenants(name) values (${`Smoke ${suffix}`}) returning id`;
    const [company] = await sql<{ id: string }[]>`
      insert into kernel.companies(tenant_id, legal_name, tax_id) values (${tenant!.id}, ${`Smoke ${suffix} S.A.S.`}, ${`7${suffix}`}) returning id`;
    const companyId = company!.id;
    const [role] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'member', false) returning id`;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${tenant!.id}, 'module:core', 'manual')`;
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
              values (${companyId}, ${role!.id}, 'core.party.consult'), (${companyId}, ${role!.id}, 'kernel.export.run')`;
    const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createError || !created.user) throw new Error(`could not create the user: ${createError?.message}`);
    const userId = created.user.id;
    await sql`insert into kernel.users(id, email, full_name) values (${userId}, ${email}, ${`Smoke ${suffix}`})`;
    const [membership] = await sql<{ id: string }[]>`insert into kernel.memberships(user_id, company_id) values (${userId}, ${companyId}) returning id`;
    await sql`insert into kernel.membership_roles(membership_id, role_id) values (${membership!.id}, ${role!.id})`;
    await sql.begin(async (tx) => {
      // Bulk fixture rows bypass the triggers (audit, seq): seq is given.
      await tx`set local session_replication_role = replica`;
      await tx`
        insert into core.parties (company_id, seq, kind, person_type, document_type, document_number, legal_name, credit_limit, dian_status)
        select ${companyId}, n, array['customer'], '1', '31', 'S' || n, 'Smoke ' || lpad(n::text, 5, '0'), 0, 'complete'
        from generate_series(1, ${ROWS}::int) as n`;
    });
    log(`seeded company ${companyId} with ${ROWS} parties and member ${userId}`);

    // ---- sign in through the compose Auth, as the web app's session cookie ----
    const jar = new Map<string, string>();
    const supabase = createServerClient(INTERNAL_SUPABASE, ANON_KEY, {
      global: { fetch: toHost },
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
      },
    });
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

    // ---- 1. an export job through the compose web app ----
    const started = await fetch(`${WEB}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        entity: "core.party",
        format: "csv",
        title: "Terceros",
        state: { filters: [], sort: [{ field: "seq", dir: "asc" }], page: 1, pageSize: 25, columns: ["seq", "legal_name", "document_number"] },
      }),
    });
    const job = (await started.json()) as { mode?: string; jobId?: string };
    if (started.status !== 202 || job.mode !== "job" || !job.jobId) throw new Error(`export did not start a job: ${started.status} ${JSON.stringify(job)}`);
    log(`POST /api/export → 202`, job);
    const done = await until("the export job", 180_000, async () => {
      const response = await fetch(`${WEB}/api/export/${job.jobId}`, { headers: { cookie } });
      const body = (await response.json()) as { status: string; url?: string; rowCount?: number; error?: string };
      if (body.status === "failed") throw new Error(`export job failed: ${JSON.stringify(body)}`);
      return body.status === "done" ? body : undefined;
    });
    log(`GET /api/export/${job.jobId} → done`, { rowCount: done.rowCount });
    const file = await toHost(done.url!);
    const lines = (await file.text()).split("\r\n").filter(Boolean);
    if (!file.ok || lines.length !== ROWS + 1) throw new Error(`the stored file is wrong: ${file.status}, ${lines.length} lines`);
    log(`signed download from the compose Storage: ${lines.length} lines (header + ${ROWS} rows)`, { first: lines[1], last: lines.at(-1) });

    // ---- 2. an outbox row dispatched by the worker's tick ----
    const chainId = randomUUID();
    const [row] = await sql<{ id: string }[]>`
      insert into kernel.outbox(company_id, event, payload, chain_id) values (${companyId}, 'core.party.updated', '{}', ${chainId}) returning id`;
    const dispatchedAt = await until("the worker's outbox tick", 90_000, async () => {
      const [state] = await sql<{ dispatched_at: Date | null }[]>`select dispatched_at from kernel.outbox where id = ${row!.id}`;
      return state?.dispatched_at ?? undefined;
    });
    log(`outbox row ${row!.id} dispatched at ${dispatchedAt.toISOString()} by the worker's tick`);

    // ---- the runs, as the Postgres World recorded them ----
    const runs = await sql<{ id: string; name: string; status: string; created_at: Date; completed_at: Date | null }[]>`
      select id, name, status, created_at, completed_at from workflow.workflow_runs
      where name like '%exportJobWorkflow' or name like '%dispatchOutboxRow'
      order by created_at desc limit 5`;
    log("workflow.workflow_runs (Postgres World)", runs.map((r) => ({ id: r.id, name: r.name, status: r.status })));
    for (const name of ["exportJobWorkflow", "dispatchOutboxRow"]) {
      if (!runs.some((r) => r.name.endsWith(name) && r.status === "completed")) throw new Error(`no completed ${name} run in the Postgres World`);
    }
    const [steps] = await sql<{ n: number }[]>`
      select count(*)::int as n from workflow.workflow_steps where run_id = any(${runs.map((r) => r.id)}::varchar[]) and status = 'completed'`;
    log(`completed steps of those runs: ${steps!.n}`);
    log("OK");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error("[smoke] FAILED", error);
  process.exit(1);
});
