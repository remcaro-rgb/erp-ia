export type ProcessErrorCode =
  | "not_entitled"
  | "forbidden"
  | "step_up_required"
  | "invalid_input"
  | "not_found"
  | "handler_failed"
  | "idempotent_replay";

/** Marks every ProcessError, whichever copy of this module created it. */
const BRAND = Symbol.for("erp.kernel.ProcessError");

/**
 * The typed failure of `runProcess`. `details` carries data for the caller (the Zod issues for
 * `invalid_input`); `cause` is the original error for `handler_failed`.
 *
 * `instanceof ProcessError` checks a global brand rather than the prototype: a bundler may load this module more
 * than once (the Workflow integration compiles the kernel a second time into a route's bundle), and a refusal
 * thrown by one copy must still be recognised by another.
 */
export class ProcessError extends Error {
  readonly code: ProcessErrorCode;
  readonly details?: unknown;
  readonly [BRAND] = true;

  constructor(code: ProcessErrorCode, message: string, options: { details?: unknown; cause?: unknown } = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "ProcessError";
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { [BRAND]?: unknown })[BRAND] === true;
  }
}
