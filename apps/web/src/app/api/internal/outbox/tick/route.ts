import { drainOutbox } from "@erp/kernel";
import { infra } from "@erp/infra";
import { secretMatches } from "@/lib/server/internal-auth";
import { processDeps } from "@/lib/server/runtime";

// The outbox tick (design §5.5, §5.10, §21): claims the undispatched outbox rows and starts one `dispatchOutboxRow`
// workflow run per row, through the service connection (rule 12: route handler). Machine to machine, never a user's:
//   POST with `x-internal-token: <INTERNAL_TOKEN>` — the Docker worker, every 30 s (apps/worker);
//   GET  with `Authorization: Bearer <CRON_SECRET>` — Vercel Cron, every minute (vercel.json), which sends only GET
//        requests with that header.
// Both answer `{ dispatched: n }`. Without the right secret: 401 and nothing is drained. The proxy does not gate
// /api/internal/* (no session); this handler is the gate.

/** Rows claimed per tick; the rest wait for the next one. */
const TICK_LIMIT = 100;

const unauthenticated = () => Response.json({ code: "unauthenticated", details: null }, { status: 401 });

async function tick(): Promise<Response> {
  const { sql } = processDeps();
  try {
    return Response.json(await infra.scheduler(() => drainOutbox(sql, TICK_LIMIT)).tick());
  } catch (error) {
    console.error("outbox tick failed", error);
    return Response.json({ code: "handler_failed", details: null }, { status: 500 });
  }
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
