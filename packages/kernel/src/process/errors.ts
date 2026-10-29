export type ProcessErrorCode =
  | "not_entitled"
  | "forbidden"
  | "step_up_required"
  | "invalid_input"
  | "not_found"
  | "handler_failed"
  | "idempotent_replay";

/**
 * Where a refusal comes from: `gate` when the pipeline of `runProcess` refuses before or around the handler (unknown
 * process, entitlement, permission, step-up, input schema), `handler` when the process's own handler throws (its
 * rules about the record: a country-pack error, a party scope the record's kind falls outside of).
 */
export type ProcessErrorStage = "gate" | "handler";

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
  /** `handler` unless `runProcess` raised it from its own checks (`gate`). */
  readonly stage: ProcessErrorStage;
  readonly [BRAND] = true;

  constructor(code: ProcessErrorCode, message: string, options: { details?: unknown; cause?: unknown; stage?: ProcessErrorStage } = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "ProcessError";
    this.code = code;
    this.stage = options.stage ?? "handler";
    if (options.details !== undefined) this.details = options.details;
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as { [BRAND]?: unknown })[BRAND] === true;
  }
}

/**
 * The reason a `forbidden` refusal carries (`details.reason`) when the caller's membership in the active company is
 * deactivated (kernel.admin.user.update, design §22.16): runProcess refuses it at the gate whatever the caller's claims
 * say, and the web app signs such a session out ("Cuenta desactivada").
 */
export const MEMBERSHIP_INACTIVE = "membership_inactive";

/** Whether `error` is runProcess's refusal of a caller whose membership is inactive. */
export function isMembershipInactive(error: unknown): boolean {
  if (!(error instanceof ProcessError) || error.code !== "forbidden") return false;
  const details = error.details as { reason?: unknown } | undefined;
  return typeof details === "object" && details !== null && details.reason === MEMBERSHIP_INACTIVE;
}
