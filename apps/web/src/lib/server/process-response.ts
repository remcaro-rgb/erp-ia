import { ProcessError } from "@erp/kernel";

// How a route handler answers a process refusal (design §5.4): the typed code and its details, with the HTTP status
// the code means. Anything that is not a ProcessError is logged and answered as handler_failed.

export const PROCESS_STATUS: Record<ProcessError["code"], number> = {
  not_entitled: 403,
  forbidden: 403,
  step_up_required: 401,
  invalid_input: 400,
  not_found: 404,
  idempotent_replay: 409,
  handler_failed: 500,
};

/** The response to a failed process run. */
export function processFailure(error: unknown): Response {
  if (error instanceof ProcessError) {
    return Response.json({ code: error.code, details: error.details ?? null }, { status: PROCESS_STATUS[error.code] });
  }
  console.error(error);
  return Response.json({ code: "handler_failed", details: null }, { status: 500 });
}

/** A refusal decided by the route itself, with one message. */
export const processProblem = (code: ProcessError["code"], detail: string) => Response.json({ code, details: [detail] }, { status: PROCESS_STATUS[code] });
