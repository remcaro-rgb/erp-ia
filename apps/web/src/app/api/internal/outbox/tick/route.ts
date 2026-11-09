import { drainOutbox } from "@erp/kernel/workflows";
import { infra } from "@erp/infra";
import { secretMatches } from "@/lib/server/internal-auth";
import { processDeps, registrySynced } from "@/lib/server/runtime";
import { runScheduledChecks, scheduledChecks, tickWithChecks } from "@/lib/server/scheduled-checks";

// The outbox tick (design §5.5, §5.10, §21): claims the undispatched outbox rows and starts one `dispatchOutboxRow`
// workflow run per row, through the service connection (rule 12: route handler). Machine to machine, never a user's:
//   POST with `x-internal-token: <INTERNAL_TOKEN>` — the Docker worker, every 30 s (apps/worker);
//   GET  with `Authorization: Bearer <CRON_SECRET>` — Vercel Cron (apps/web/vercel.json: daily while the Vercel account is on
//        the Hobby plan, which allows no more; every minute on Pro), which sends only GET
//        requests with that header.
// Both answer `{ dispatched: n }`. Without the right secret: 401 and nothing is drained. The proxy does not gate
// /api/internal/* (no session); this handler is the gate. After the drain, each in its own try/catch, the scheduled checks run
// (lib/server/scheduled-checks.ts, plan 2B.2 Task 52.7, R52-6): they never change the tick's answer.

/** Rows claimed per tick; the rest wait for the next one. */
const TICK_LIMIT = 100;

const unauthenticated = () => Response.json({ code: "unauthenticated", details: null }, { status: 401 });

async function tick(): Promise<Response> {
  const deps = processDeps();
  const outcome = await tickWithChecks(
    () => infra.scheduler(() => drainOutbox(deps.sql, TICK_LIMIT)).tick(),
    // The checks raise kernel recommendations, which name their process from kernel.registered_processes: the manifests first.
    async () => {
      await registrySynced();
      return runScheduledChecks(scheduledChecks(deps));
    },
  );
  return outcome.ok ? Response.json(outcome.result) : Response.json({ code: "handler_failed", details: null }, { status: 500 });
}

export async function POST(request: Request): Promise<Response> {
  if (!secretMatches(request.headers.get("x-internal-token"), process.env.INTERNAL_TOKEN)) return unauthenticated();
  return tick();
}

export async function GET(request: Request): Promise<Response> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  if (!secretMatches(bearer, process.env.CRON_SECRET)) return unauthenticated();
  return tick();
}
