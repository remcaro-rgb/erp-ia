import { randomUUID } from "node:crypto";
import type { JSONValue, Sql } from "postgres";
import type { z } from "zod";
import "../zod-locale";
import { setAuditContext, writeAudit, type AuditAction } from "../audit/audit";
import { withClaims, type JwtClaims, type Tx } from "../db/client";
import { entitled as resolveEntitled, type EntitledFn } from "../entitlements/resolver";
import { enqueueEvent } from "../events/outbox";
import type { Registry } from "../registry";
import type { ProcessDef, ProcessKind } from "../registry/types";
import type { Caller, ProcessContext } from "./context";
import { ProcessError, type ProcessErrorCode } from "./errors";

export interface RunProcessDeps {
  sql: Sql;
  registry: Registry;
  /** Entitlement check; defaults to the SQL resolver `kernel.entitled`. Tests may inject another. */
  entitled?: EntitledFn;
}

/** A process run by id has no static output type unless the caller names its output schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UntypedOutput = z.ZodType<any>;

const ACTION: Record<ProcessKind, AuditAction> = { create: "insert", update: "update", delete: "delete", consult: "consult" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunProcessOptions {
  /**
   * Runs the whole pipeline (resolve, entitlement, permission, step-up, input, handler) in a transaction that is
   * always rolled back: the handler's output (or its refusal) comes back, and no record, audit, outbox or
   * idempotency row is written. A denial is still audited; an idempotency key already stored answers its stored
   * result, as a real run would. The importer validates rows this way (Task 13b). Only what the handler does in
   * `ctx.tx` is undone: handlers read `ctx.dryRun` and skip any effect outside the database.
   */
  dryRun?: boolean;
  /**
   * Idempotency key of this run when the process declares none (or instead of its own): a second run with the same
   * key in the company answers the first run's stored result without running again. The importer keys each row by
   * `import:<importId>:<rowIndex>`, so a retried batch replays instead of creating twice.
   */
  idempotencyKey?: string;
  /**
   * The record this creation was cloned from (rule 37, design §22.13): a `create` process only. The run's audit entry
   * and the row trigger's insert entries record it as `source_row_id`, so the viewer shows "clonado desde …". Anything
   * but a record id, or a process of another kind, is refused as `invalid_input`.
   */
  sourceRowId?: string;
}

/** Thrown inside a dry run's transaction to roll it back while carrying the handler's output out. */
class DryRunRollback {
  constructor(readonly output: unknown) {}
}

/** Refusals the pipeline raises itself carry `stage: "gate"`; the handler's own keep the default `handler`. */
const GATE = { stage: "gate" } as const;

/**
 * SQL refusals (final review M9). A trigger, hook or function a handler reaches may refuse the change in a way the
 * user can act on by raising with the default SQLSTATE `P0001` and a message that starts with SQL_INVALID_INPUT:
 *
 *   raise exception 'erp:invalid_input:El ticket está cerrado: sus archivos ya no pueden cambiar';
 *
 * `runProcess` turns it into `ProcessError("invalid_input")` (stage `handler`) whose message and single detail are the
 * text after the prefix, so it must be the user's copy (Spanish, like every handler's `invalid_input` details). Any
 * other database error stays `handler_failed`. Example: `support.attachments_changed` (0017).
 */
export const SQL_INVALID_INPUT = "erp:invalid_input:";

/** The typed refusal a SQL error carries, if it follows the SQL_INVALID_INPUT convention. */
function sqlRefusal(cause: unknown): ProcessError | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const { code, message } = cause as { code?: unknown; message?: unknown };
  if (code !== "P0001" || typeof message !== "string" || !message.startsWith(SQL_INVALID_INPUT)) return undefined;
  const text = message.slice(SQL_INVALID_INPUT.length).trim();
  return new ProcessError("invalid_input", text, { details: [text], cause, stage: "handler" });
}

/** Refusals recorded in the audit log with action `denied` (design §5.4 step 2). */
const DENIALS = new Set<ProcessErrorCode>(["not_entitled", "forbidden", "step_up_required"]);

/**
 * Runs a registered process for `caller` (design §5.4). In order: resolve (`not_found`),
 * entitlements (`not_entitled`), permission (`forbidden`, skipped for `permission: "none"`), step-up (`step_up_required`), input
 * (`invalid_input`), idempotent replay, then one transaction as the caller holding the step-up
 * consumption, the handler, its outbox events, the audit row and the idempotency record. A handler
 * error rolls all of it back and surfaces as `handler_failed`, except a `ProcessError` the handler
 * throws itself, which keeps its code (a denial code is then audited like any other denial), and a SQL refusal raised
 * with the `SQL_INVALID_INPUT` prefix, which becomes `invalid_input`. A denial is audited (action `denied`)
 * in its own committed transaction, on the attempt's chain. With `options.dryRun` the transaction is always
 * rolled back after the handler (see `RunProcessOptions`).
 */
export async function runProcess<O extends z.ZodTypeAny = UntypedOutput>(
  deps: RunProcessDeps,
  caller: Caller,
  processId: string,
  input: unknown,
  options: RunProcessOptions = {},
): Promise<z.infer<O>> {
  const def = resolve(deps.registry, processId);
  const chainId = caller.chainId ?? randomUUID();
  try {
    return await execute<O>(deps, caller, def, chainId, input, options);
  } catch (error) {
    if (error instanceof ProcessError && DENIALS.has(error.code)) {
      await withClaims(deps.sql, caller.claims, (tx) =>
        writeAudit(tx, {
          ...auditDefaults(def, caller, chainId),
          action: "denied",
          input: { code: error.code, process_id: def.id },
        }),
      );
    }
    throw error;
  }
}

async function execute<O extends z.ZodTypeAny>(
  deps: RunProcessDeps,
  caller: Caller,
  def: ProcessDef,
  chainId: string,
  input: unknown,
  options: RunProcessOptions,
): Promise<z.infer<O>> {
  const { claims } = caller;
  const dryRun = options.dryRun === true;
  const companyId = claims.active_company_id;

  const entitled = deps.entitled ?? resolveEntitled;
  // The process key already resolves through its feature and module (and a module the company disabled).
  // The kernel is the platform, not something a tenant buys: its processes are always entitled.
  if (def.module !== "kernel" && !(await entitled(deps.sql, companyId, `process:${def.id}`))) {
    throw new ProcessError("not_entitled", `process ${def.id} is not entitled for company ${companyId}`, GATE);
  }

  const stepUpToken = caller.stepUpToken ?? null;
  const gate = await withClaims(deps.sql, claims, async (tx) => {
    const [row] = await tx<{ allowed: boolean; member: boolean; sensitive: boolean; verified: boolean }[]>`
      select
        kernel.can_run_process(${def.id}) as allowed,
        coalesce(kernel.current_company_id() = any (kernel.current_company_ids()), false) as member,
        exists (
          select 1 from kernel.sensitive_processes sp where sp.company_id = ${companyId} and sp.process_id = ${def.id}
        ) as sensitive,
        exists (
          select 1 from kernel.step_up_verifications v
          where v.token = ${stepUpToken} and v.user_id = ${claims.sub} and v.company_id = ${companyId}
            and v.verified_at > now() - interval '5 minutes' and v.consumed_at is null
        ) as verified`;
    return row!;
  });
  // A self-service process (`permission: "none"`) needs no row in the role matrix, only membership of the
  // active company; everything else needs a role that allows it.
  if (def.permission === "none" ? !gate.member : !gate.allowed) throw new ProcessError("forbidden", `no role of the caller may run ${def.id}`, GATE);
  const stepUp = gate.sensitive || def.sensitivity === "step-up";
  if (stepUp && !gate.verified) throw new ProcessError("step_up_required", `${def.id} requires a fresh step-up verification`, GATE);

  if (options.sourceRowId !== undefined) {
    if (def.kind !== "create") throw new ProcessError("invalid_input", `${def.id} creates nothing: it has no source record`, { details: ["Solo una creación tiene registro de origen"], stage: "gate" });
    if (!UUID.test(options.sourceRowId)) throw new ProcessError("invalid_input", `source record ${options.sourceRowId} is not a record id`, { details: ["El registro de origen no es válido"], stage: "gate" });
  }

  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    throw new ProcessError("invalid_input", `invalid input for ${def.id}`, { details: parsed.error.issues, stage: "gate" });
  }

  const key = options.idempotencyKey ?? def.idempotencyKey?.(parsed.data);
  if (key !== undefined) {
    const stored = await storedResult(deps.sql, claims, def.id, key);
    if (stored) return stored.result as z.infer<O>;
  }

  try {
    return await withClaims(deps.sql, claims, async (tx) => {
      await setAuditContext(tx, {
        origin: caller.origin,
        processId: def.id,
        chainId,
        actorUserId: claims.sub,
        conversationId: caller.conversationId,
        sourceRowId: options.sourceRowId,
      });
      if (stepUp) await consumeStepUp(tx, def.id, stepUpToken!, claims.sub, companyId);

      // The roles the caller still holds (0024: the claim's roles intersected with the live memberships), so a role
      // revoked after the token was issued no longer counts for the handler's own checks (custom-field roles).
      const [live] = await tx<{ role_ids: string[] }[]>`select kernel.current_role_ids() as role_ids`;
      const ctx = buildContext(tx, deps.registry, def, caller, chainId, dryRun, live!.role_ids);
      let output: unknown;
      try {
        output = await def.handler(ctx, parsed.data);
      } catch (cause) {
        // A handler refuses with a typed error (e.g. invalid_input from a country-pack validator): keep it. So does a
        // SQL refusal raised with the SQL_INVALID_INPUT prefix.
        if (cause instanceof ProcessError) throw cause;
        throw sqlRefusal(cause) ?? new ProcessError("handler_failed", `process ${def.id} failed`, { cause });
      }
      // A dry run ends here: everything the handler wrote (and the step-up consumption) is rolled back.
      if (dryRun) throw new DryRunRollback(output);

      await writeAudit(tx, {
        ...auditDefaults(def, caller, chainId),
        rowId: rowIdOf(output),
        input: def.auditInput ? def.auditInput(parsed.data) : parsed.data,
        sourceRowId: options.sourceRowId,
      });

      if (key !== undefined) {
        const inserted = await tx`
          insert into kernel.process_idempotency (company_id, process_id, key, result)
          values (${companyId}, ${def.id}, ${key}, ${tx.json((output ?? null) as JSONValue)})
          on conflict do nothing
          returning key`;
        // A concurrent run with the same key committed first: undo this one and replay that one.
        if (inserted.length === 0) throw new ProcessError("idempotent_replay", `${def.id} already ran with key ${key}`, GATE);
      }
      return output as z.infer<O>;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.output as z.infer<O>;
    if (key !== undefined && error instanceof ProcessError && error.code === "idempotent_replay") {
      const stored = await storedResult(deps.sql, claims, def.id, key);
      if (stored) return stored.result as z.infer<O>;
    }
    throw error;
  }
}

function resolve(registry: Registry, processId: string): ProcessDef {
  try {
    return registry.process(processId);
  } catch {
    throw new ProcessError("not_found", `unknown process: ${processId}`, GATE);
  }
}

async function storedResult(sql: Sql, claims: JwtClaims, processId: string, key: string) {
  const [row] = await withClaims(
    sql,
    claims,
    (tx) => tx<{ result: unknown }[]>`
      select result from kernel.process_idempotency
      where company_id = ${claims.active_company_id} and process_id = ${processId} and key = ${key}`,
  );
  return row;
}

/** Marks the caller's verification consumed; a concurrent run that consumed it first wins. */
async function consumeStepUp(tx: Tx, processId: string, token: string, userId: string, companyId: string) {
  const consumed = await tx`
    update kernel.step_up_verifications set consumed_at = now()
    where token = ${token} and user_id = ${userId} and company_id = ${companyId}
      and verified_at > now() - interval '5 minutes' and consumed_at is null
    returning id`;
  if (consumed.length === 0) throw new ProcessError("step_up_required", `${processId} requires a fresh step-up verification`, GATE);
}

function buildContext(tx: Tx, registry: Registry, def: ProcessDef, caller: Caller, chainId: string, dryRun: boolean, roleIds: string[]): ProcessContext {
  const { claims } = caller;
  return {
    tx,
    registry,
    companyId: claims.active_company_id,
    tenantId: claims.tenant_id,
    userId: claims.sub,
    roleIds,
    locale: claims.locale,
    origin: caller.origin,
    chainId,
    conversationId: caller.conversationId,
    dryRun,
    async emit(event, payload) {
      await enqueueEvent(tx, { companyId: claims.active_company_id, event, payload, chainId });
    },
    async audit(entry) {
      // The handler may describe the entry, never change who did it or from where.
      const defaults = auditDefaults(def, caller, chainId);
      const { companyId, actorUserId, origin } = defaults;
      await writeAudit(tx, { ...defaults, ...entry, companyId, actorUserId, origin });
    },
  };
}

function auditDefaults(def: ProcessDef, caller: Caller, chainId: string) {
  return {
    companyId: caller.claims.active_company_id,
    actorUserId: caller.claims.sub,
    origin: caller.origin,
    processId: def.id,
    // `sales.order.confirm` acts on the entity `sales.order`.
    entity: def.id.includes(".") ? def.id.slice(0, def.id.lastIndexOf(".")) : def.id,
    action: ACTION[def.kind],
    chainId,
    conversationId: caller.conversationId,
  };
}

function rowIdOf(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null || !("id" in output)) return undefined;
  return typeof output.id === "string" && UUID.test(output.id) ? output.id : undefined;
}
