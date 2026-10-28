export type ProcessErrorCode =
  | "not_entitled"
  | "forbidden"
  | "step_up_required"
  | "invalid_input"
  | "not_found"
  | "handler_failed"
  | "idempotent_replay";

/**
 * The typed failure of `runProcess`. `details` carries data for the caller (the Zod issues for
 * `invalid_input`); `cause` is the original error for `handler_failed`.
 */
export class ProcessError extends Error {
  readonly code: ProcessErrorCode;
  readonly details?: unknown;

  constructor(code: ProcessErrorCode, message: string, options: { details?: unknown; cause?: unknown } = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "ProcessError";
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}
