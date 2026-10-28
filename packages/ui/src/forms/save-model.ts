// How a record form saves (rule 1: through the entity's create / update process, as the session's user) and what it
// hears back. The app supplies `save` (a server action) and `requestStepUp` (POST /api/auth/step-up); the form only
// knows these shapes.

/** One message of a refusal; `path` names the input field it is about (a Zod issue), absent for the pack's messages. */
export interface SaveIssue {
  path?: string[];
  message: string;
}

/** The answer of a save: the record's id, or the process's refusal with its details (`invalid_input` messages). */
export type SaveResult = { ok: true; id: string } | { ok: false; code: string; details: SaveIssue[] };

/** Runs the create (no id) or update process with `input`; `stepUpToken` answers a `step_up_required`. */
export type SaveRecord = (input: Record<string, unknown>, stepUpToken?: string) => Promise<SaveResult>;

/** Turns a TOTP code into a step-up token, or says why not (`invalid_code`, `too_many_attempts`…). */
export type RequestStepUp = (code: string) => Promise<{ token: string } | { error: string }>;

/** Option of a code table (document types, taxes, units…), from the country pack. */
export interface CodeOption {
  code: string;
  name: string;
}
