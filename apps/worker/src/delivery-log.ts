import http, { type ClientRequest } from "node:http";

// Evidence of which process consumed a job. The Postgres World's graphile runner delivers each claimed workflow or
// step job with an HTTP POST (node:http, @workflow/world/node-http) to the web app's /.well-known/workflow/v1/flow; in
// world-postgres 5 every process that enqueues runs a runner too, so the web app and the worker both consume. This
// wraps `http.request` in the worker to log the deliveries it made: `[worker <name>] delivered <queue> run=<id> status=<n>`.

const FLOW_PATH = "/.well-known/workflow/v1/flow";
const RUN_ID = /"runId":"(wrun_[0-9A-Za-z]+)"/;
/** Bytes of the body kept to find the run id. */
const SNIFF_BYTES = 4096;

function pathOf(target: unknown): string {
  if (typeof target === "string") return new URL(target, "http://x").pathname;
  if (target instanceof URL) return target.pathname;
  if (target && typeof target === "object" && "path" in target) return String((target as { path?: string }).path ?? "");
  return "";
}

/** Starts logging this process's flow deliveries; answers the function that stops it. */
export function logDeliveries(name: string, log: (line: string) => void = console.log): () => void {
  const original = http.request;
  const wrapped = function (this: unknown, ...args: unknown[]): ClientRequest {
    const request = (original as (...a: unknown[]) => ClientRequest).apply(this, args);
    if (!pathOf(args[0]).startsWith(FLOW_PATH)) return request;
    let sniffed = "";
    const keep = (chunk: unknown) => {
      if (sniffed.length < SNIFF_BYTES && (typeof chunk === "string" || chunk instanceof Uint8Array)) {
        sniffed += (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")).slice(0, SNIFF_BYTES);
      }
    };
    const write = request.write.bind(request);
    const end = request.end.bind(request);
    request.write = ((chunk: unknown, ...rest: unknown[]) => (keep(chunk), (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof request.write;
    request.end = ((chunk?: unknown, ...rest: unknown[]) => (keep(chunk), (end as (...a: unknown[]) => ClientRequest)(chunk, ...rest))) as typeof request.end;
    request.once("response", (response) => {
      const queue = String(request.getHeader("x-vqs-queue-name") ?? "?");
      const run = RUN_ID.exec(sniffed)?.[1] ?? "?";
      log(`[worker ${name}] delivered ${queue} run=${run} status=${response.statusCode}`);
    });
    return request;
  };
  http.request = wrapped as typeof http.request;
  return () => {
    if (http.request === wrapped) http.request = original;
  };
}
