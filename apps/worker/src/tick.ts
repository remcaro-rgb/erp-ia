// One outbox tick from the worker (design §5.5, §21): POST /api/internal/outbox/tick on the web app, which drains the
// outbox and starts the dispatch workflow runs. The drain stays in the web app because `start()` needs the workflow
// functions compiled by the Workflow build (withWorkflow); this process has none and only drives the schedule.

export interface TickOptions {
  /** The web app on the compose's internal network, e.g. http://web:3000. */
  webUrl: string;
  /** INTERNAL_TOKEN, shared with the web app. */
  token: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/** Calls the tick route once and answers how many runs it started; throws on any refusal or failure. */
export async function tickOutbox({ webUrl, token, fetcher = fetch, timeoutMs = 25_000 }: TickOptions): Promise<number> {
  const response = await fetcher(`${webUrl.replace(/\/+$/, "")}/api/internal/outbox/tick`, {
    method: "POST",
    headers: { "x-internal-token": token },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`outbox tick answered ${response.status}`);
  const body = (await response.json()) as { dispatched?: unknown };
  if (typeof body.dispatched !== "number") throw new Error("outbox tick answered without dispatched");
  return body.dispatched;
}
