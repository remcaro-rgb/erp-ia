import type { Tx } from "../db/client";
import { validateEmail } from "../validation";
import { verifierAdapter, type VerifyKind } from "./adapters";

export type VerifyStatus = "queued" | "verified" | "failed";

export interface VerifyContext {
  companyId: string;
  entity: string;
  recordId: string;
}

export interface VerifyOutcome {
  id: string;
  status: VerifyStatus;
  provider: string | null;
}

/** The normalized value of `kind`, or why it cannot be verified (Spanish, for the form). */
export function normalizeVerifyValue(kind: VerifyKind, raw: string): { value: string } | { error: string } {
  const value = raw.trim();
  if (kind === "email") {
    const problem = validateEmail(value);
    return problem ? { error: `Correo: ${problem}` } : { value };
  }
  if (kind === "phone") {
    const phone = value.replace(/[\s-]/g, "");
    return /^\+\d{7,17}$/.test(phone) ? { value: phone } : { error: "Teléfono: usa el formato +<indicativo><número>" };
  }
  return value.length > 0 && value.length <= 40 ? { value } : { error: "Identificación: indica el tipo y el número (máximo 40 caracteres)" };
}

/**
 * Asks the company's provider for `kind` to verify `value` and records the request in `tx`, a process
 * transaction (the table only accepts rows from `kernel.verify.*` processes).
 *
 * - No provider configured: the request is `queued` and waits for one (the UI shows "en cola"). Asking again for the
 *   same datum of the same record while one is queued returns that request instead of adding another.
 * - A provider without an installed adapter: also `queued`, with the provider named, so nothing is lost.
 * - Otherwise the adapter answers: `verified` or `failed`; an adapter that throws is `failed` with its message.
 */
export async function verify(tx: Tx, kind: VerifyKind, value: string, ctx: VerifyContext): Promise<VerifyOutcome> {
  const [verifier] = await tx<{ provider: string | null }[]>`select provider from kernel.verifiers where company_id = ${ctx.companyId} and kind = ${kind}`;
  const provider = verifier?.provider ?? null;
  const adapter = provider ? verifierAdapter(provider) : undefined;

  let status: VerifyStatus = "queued";
  let result: unknown = null;
  if (!adapter) {
    // Nothing can answer yet: the datum already waiting in the queue (same provider, or none) is the request.
    const [waiting] = await tx<{ id: string }[]>`
      select id from kernel.verification_requests
      where company_id = ${ctx.companyId} and entity = ${ctx.entity} and record_id = ${ctx.recordId} and kind = ${kind} and value = ${value}
        and status = 'queued' and provider is not distinct from ${provider}
      order by created_at desc, id desc limit 1`;
    if (waiting) return { id: waiting.id, status: "queued", provider };
  } else {
    try {
      const answer = await adapter.verify(kind, value);
      status = answer.ok ? "verified" : "failed";
      result = answer.detail ?? null;
    } catch (error) {
      status = "failed";
      result = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const [row] = await tx<{ id: string }[]>`
    insert into kernel.verification_requests (company_id, kind, value, entity, record_id, status, provider, result)
    values (${ctx.companyId}, ${kind}, ${value}, ${ctx.entity}, ${ctx.recordId}, ${status}, ${provider},
            ${result === null ? null : tx.json(result as Parameters<typeof tx.json>[0])})
    returning id`;
  return { id: row!.id, status, provider };
}
