import type { ExportFormat, GridStateInput } from "./types";

// The browser side of an export (design §9, rule 20): POST /api/export with the grid's state. Under 10,000 rows the
// answer is the file itself; from there on it is 202 { mode: "job", jobId } and GET /api/export/:jobId is polled until
// the job is done and carries a signed link. Pure over an injected `fetch`, so it is tested without a browser.

export interface ExportSource {
  kind: "report";
  id: string;
  params: Record<string, unknown>;
}

export interface ExportRequest {
  entity: string;
  format: ExportFormat;
  state: GridStateInput;
  title?: string;
  /** A report's export: the server reads the report's consult with these parameters instead of an entity's grid. */
  source?: ExportSource;
}

export type ExportResult =
  /** The file itself (an inline export). */
  | { kind: "file"; blob: Blob; fileName: string }
  /** A signed link to the file a job made. */
  | { kind: "link"; url: string; fileName?: string };

export interface ExportOptions {
  endpoint?: string;
  fetcher?: typeof fetch;
  /** Milliseconds between two looks at a job. */
  pollMs?: number;
  /** How long to wait for a job before giving up (`export_timeout`); 10 minutes by default. The job itself carries on. */
  maxWaitMs?: number;
  /** Called once when the server turned the export into a background job. */
  onJob?: () => void;
  signal?: AbortSignal;
}

/** A refusal or failure of an export: the server's code (`forbidden`, `not_entitled`…), `export_failed`, `export_timeout`, `network` or `aborted`. */
export class ExportRequestError extends Error {
  readonly code: string;
  readonly status: number;
  /** The server's one-word reason for an `invalid_input` (`pdf_too_large`), when it gave one. */
  readonly detail?: string;
  constructor(code: string, status = 0, detail?: string) {
    super(`export failed: ${code}${status ? ` (${status})` : ""}`);
    this.name = "ExportRequestError";
    this.code = code;
    this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

/** The file name in a Content-Disposition header, or `fallback`. */
export function fileNameOf(disposition: string | null, fallback: string): string {
  const match = disposition ? /filename="([^"]+)"|filename=([^;]+)/.exec(disposition) : null;
  return (match?.[1] ?? match?.[2])?.trim() || fallback;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new ExportRequestError("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new ExportRequestError("aborted"))), { once: true });
  });

/** Asks for the export and waits for it: the file, or the link of the job's file. Throws `ExportRequestError`. */
export async function requestExport(request: ExportRequest, options: ExportOptions = {}): Promise<ExportResult> {
  const { endpoint = "/api/export", fetcher = (...args: Parameters<typeof fetch>) => fetch(...args), pollMs = 2000, maxWaitMs = 600_000, onJob, signal } = options;
  const call = async (url: string, init?: RequestInit): Promise<Response> => {
    try {
      return await fetcher(url, { ...init, signal });
    } catch {
      throw signal?.aborted ? new ExportRequestError("aborted") : new ExportRequestError("network");
    }
  };
  const failure = async (response: Response) => {
    const body = (await response.json().catch(() => null)) as { code?: string; details?: unknown } | null;
    const detail = Array.isArray(body?.details) && typeof body.details[0] === "string" ? body.details[0] : undefined;
    return new ExportRequestError(body?.code ?? "handler_failed", response.status, detail);
  };

  const started = await call(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  if (!started.ok) throw await failure(started);
  if (started.status !== 202) {
    return { kind: "file", blob: await started.blob(), fileName: fileNameOf(started.headers.get("content-disposition"), `${request.entity}.${request.format}`) };
  }

  const { jobId } = (await started.json()) as { jobId: string };
  onJob?.();
  const giveUpAt = Date.now() + maxWaitMs;
  for (;;) {
    if (Date.now() >= giveUpAt) throw new ExportRequestError("export_timeout");
    await wait(pollMs, signal);
    const polled = await call(`${endpoint}/${encodeURIComponent(jobId)}`);
    if (!polled.ok) throw await failure(polled);
    const job = (await polled.json()) as { status: string; url?: string; fileName?: string };
    if (job.status === "failed") throw new ExportRequestError("export_failed");
    if (job.status === "done" && job.url) return { kind: "link", url: job.url, ...(job.fileName ? { fileName: job.fileName } : {}) };
  }
}
