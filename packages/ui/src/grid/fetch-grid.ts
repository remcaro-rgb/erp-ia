import type { GridFetcher, GridPage } from "./types";

/** A refusal of the grid route, with its code (`field_hidden`, `forbidden`, `not_entitled`…). */
export class GridFetchError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(`grid request failed: ${code} (${status})`);
    this.name = "GridFetchError";
    this.code = code;
    this.status = status;
  }
}

/** The fetcher of an entity's grid: POST /api/grid/<entity> with the state as JSON (design §9). */
export function gridFetcher(entity: string, endpoint = "/api/grid"): GridFetcher {
  return async (state, signal) => {
    const response = await fetch(`${endpoint}/${encodeURIComponent(entity)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
      signal,
    });
    const body = (await response.json().catch(() => null)) as (GridPage & { code?: string }) | null;
    if (!response.ok || !body) throw new GridFetchError(body?.code ?? "handler_failed", response.status);
    return body;
  };
}

/** The code of a failed request, for its message. */
export const failureCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "network";
