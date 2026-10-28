import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

// End-to-end check of the Docker stack (design §21, Task 21): real workflows through the compose edge, web app and
// Workflow Postgres World, from outside the compose network (CI and `pnpm -F worker smoke`, with the stack started by
// `pnpm docker:test:up`). It seeds its own tenant, so run it against a disposable stack (`pnpm docker:down`).
//  0. The edge: the flow route and the tick answer 403 without `x-workflow-internal-token`, 2xx with it; a signed-in
//     browser's same-origin POST /api/prefs (Origin http://127.0.0.1:56300) is accepted, another origin is not.
//  1. An export job: a member signs in through the compose Auth, POST /api/export of 10,001 parties as CSV answers
//     202 { mode: "job" }; the `exportJobWorkflow` run runs on the Postgres World; the file lands in the compose
//     Storage; GET /api/export/:jobId answers done.
//  2. The outbox: event rows are dispatched by the worker's 30 s tick (POST /api/internal/outbox/tick), each by a
//     `dispatchOutboxRow` run on the same World.
//  3. The runs are read from the World's own tables (`workflow.workflow_runs`), and the worker's delivery log
//     (`docker compose logs worker`) must show at least one of their jobs delivered by the worker container.
//
// Environment (the values of .env.docker; the defaults are the published host ports): SMOKE_WEB_URL (the edge,
// http://127.0.0.1:56300), SMOKE_SUPABASE_URL (http://127.0.0.1:56321), SMOKE_DATABASE_URL
// (postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:56322/postgres), ANON_KEY, SERVICE_ROLE_KEY, INTERNAL_TOKEN,
// WORKFLOW_INTERNAL_TOKEN, SUPABASE_INTERNAL_URL (http://kong:8000: the URL the web app knows Auth by, which names its
// session cookie), SMOKE_ENV_FILE (.env.docker, for `docker compose logs`).

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
const INTERNAL_TOKEN = env("INTERNAL_TOKEN");
const WORKFLOW_INTERNAL_TOKEN = env("WORKFLOW_INTERNAL_TOKEN");
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const ENV_FILE = env("SMOKE_ENV_FILE", ".env.docker");
const ROWS = 10_001;
const OUTBOX_ROWS = 5;

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
  const startedAt = new Date();
  try {
    // ---- 0. the edge guards the workflow and internal routes ----
    const health = (headers: Record<string, string>) => fetch(`${WEB}/.well-known/workflow/v1/flow?__health`, { method: "POST", headers });
    const tick = (headers: Record<string, string>) => fetch(`${WEB}/api/internal/outbox/tick`, { method: "POST", headers });
    const edge = {
      flowWithoutToken: (await health({})).status,
      flowWrongToken: (await health({ "x-workflow-internal-token": "wrong" })).status,
      flowWithToken: (await health({ "x-workflow-internal-token": WORKFLOW_INTERNAL_TOKEN })).status,
      tickWithoutEdgeToken: (await tick({ "x-internal-token": INTERNAL_TOKEN })).status,
      tickWithBothTokens: (await tick({ "x-internal-token": INTERNAL_TOKEN, "x-workflow-internal-token": WORKFLOW_INTERNAL_TOKEN })).status,
    };
    log("edge", edge);
    if (edge.flowWithoutToken !== 403 || edge.flowWrongToken !== 403 || edge.tickWithoutEdgeToken !== 403) throw new Error("the edge let a guarded route through");
    if (edge.flowWithToken >= 300 || edge.tickWithBothTokens !== 200) throw new Error("the edge refused the internal token");

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
              values (${companyId}, ${role!.id}, 'core.party.consult'), (${companyId}, ${role!.id}, 'kernel.export.run'),
                     (${companyId}, ${role!.id}, 'kernel.user_prefs.set')`;
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

    // ---- a browser's same-origin request through the edge: the app must see the host with its port ----
    const origin = new URL(WEB).origin;
    const prefs = (from: string) =>
      fetch(`${WEB}/api/prefs`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: from, cookie },
        body: JSON.stringify({ key: "theme", value: "dark", savedAt: Date.now() }),
      });
    const sameOrigin = { [origin]: (await prefs(origin)).status, "http://evil.example": (await prefs("http://evil.example")).status };
    log("POST /api/prefs through the edge, by Origin", sameOrigin);
    if (sameOrigin[origin] !== 204 || sameOrigin["http://evil.example"] !== 403) throw new Error("the app does not see the browser's origin as its own");

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

    // ---- 2. outbox rows dispatched by the worker's tick ----
    const rows = await sql<{ id: string }[]>`
      insert into kernel.outbox(company_id, event, payload, chain_id)
      select ${companyId}, 'core.party.updated', '{}', gen_random_uuid() from generate_series(1, ${OUTBOX_ROWS}::int) returning id`;
    const ids = rows.map((r) => r.id);
    await until("the worker's outbox tick", 90_000, async () => {
      const [state] = await sql<{ left: number }[]>`select count(*)::int as left from kernel.outbox where id = any(${ids}::uuid[]) and dispatched_at is null`;
      return state!.left === 0 ? true : undefined;
    });
    log(`${OUTBOX_ROWS} outbox rows dispatched by the worker's tick`);

    // ---- 3. the runs, as the Postgres World recorded them, and who delivered their jobs ----
    const runs = await sql<{ id: string; name: string; status: string }[]>`
      select id, name, status from workflow.workflow_runs
      where created_at >= ${startedAt} and (name like '%exportJobWorkflow' or name like '%dispatchOutboxRow')
      order by created_at`;
    log("workflow.workflow_runs (Postgres World)", runs.map((r) => ({ id: r.id, name: r.name.split("//").at(-1), status: r.status })));
    const exports = runs.filter((r) => r.name.endsWith("exportJobWorkflow") && r.status === "completed");
    const dispatches = runs.filter((r) => r.name.endsWith("dispatchOutboxRow") && r.status === "completed");
    if (exports.length < 1 || dispatches.length < OUTBOX_ROWS) throw new Error(`runs not completed: ${exports.length} export, ${dispatches.length} dispatch`);
    const [steps] = await sql<{ n: number }[]>`
      select count(*)::int as n from workflow.workflow_steps where run_id = any(${runs.map((r) => r.id)}::varchar[]) and status = 'completed'`;
    log(`completed steps of those runs: ${steps!.n}`);

    const workerLog = execFileSync("docker", ["compose", "--env-file", ENV_FILE, "logs", "--no-log-prefix", "worker"], { cwd: ROOT, encoding: "utf8" });
    const runIds = new Set(runs.map((r) => r.id));
    const delivered = workerLog
      .split("\n")
      .map((line) => /^\[worker (\S+)\] delivered (\S+) run=(\S+) status=(\d+)/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null && runIds.has(m[3]!));
    log(`jobs of these runs delivered by the worker container: ${delivered.length}`, delivered.slice(0, 6).map((m) => `${m[1]} ${m[2]} ${m[3]} ${m[4]}`));
    if (delivered.length === 0) throw new Error("no job of these runs was delivered by the worker");
    log("OK");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error("[smoke] FAILED", error);
  process.exit(1);
});
