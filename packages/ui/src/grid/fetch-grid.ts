import type { GridFetcher, GridPage } from "./types";

/** A refusal of the grid route, with its code (`field_hidden`, `forbidden`, `not_entitled`…). */
export class GridFetchError extends Error {
  readonly code: string;
  readonly status: number;
  /** The refusal's own notes (Spanish copy of the process), as the route sends them. */
  readonly details: string[];
  constructor(code: string, status: number, details: string[] = []) {
    super(`grid request failed: ${code} (${status})`);
    this.name = "GridFetchError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** The string notes of a refusal body; anything else is no notes. */
export const detailsOf = (details: unknown): string[] => (Array.isArray(details) ? details.filter((d): d is string => typeof d === "string") : []);

/** The fetcher of an entity's grid: POST /api/grid/<entity> with the state as JSON (design §9). */
export function gridFetcher(entity: string, endpoint = "/api/grid"): GridFetcher {
  return async (state, signal) => {
    const response = await fetch(`${endpoint}/${encodeURIComponent(entity)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
      signal,
    });
    const body = (await response.json().catch(() => null)) as (GridPage & { code?: string; details?: unknown }) | null;
    if (!response.ok || !body) throw new GridFetchError(body?.code ?? "handler_failed", response.status, detailsOf(body?.details));
    return body;
  };
}

/** Refusals whose first detail is copy meant for the user (the process's own Spanish note). */
const NOTED_CODES = new Set(["forbidden", "not_found", "invalid_input"]);

/** The code of a failed request and, for a noted refusal, its note. */
export function failureOf(error: unknown): { code: string; note: string | null } {
  const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "network";
  const details = typeof error === "object" && error !== null && "details" in error ? detailsOf((error as { details: unknown }).details) : [];
  return { code, note: NOTED_CODES.has(code) ? (details[0] ?? null) : null };
}

/** The code of a failed request, for its message. */
export const failureCode = (error: unknown): string => failureOf(error).code;
