import { randomUUID } from "node:crypto";
import type { JSONValue, Sql } from "postgres";
import type { z } from "zod";
import "../zod-locale";
import { countDryRunDenial, setAuditContext, writeAudit, type AuditAction } from "../audit/audit";
import { withClaims, type JwtClaims, type Tx } from "../db/client";
import { entitled as resolveEntitled, type EntitledFn } from "../entitlements/resolver";
import { enqueueEvent } from "../events/outbox";
import { makeRecommendations } from "../home/recommend";
import { makeLinks } from "../links/links";
import { consultProcessesOf } from "../query/access";
import type { Registry } from "../registry";
import type { ResolvedEntityDef } from "../registry/entities";
import { IDENTIFIER } from "../registry/fields";
import type { ProcessDef, ProcessKind } from "../registry/types";
import type { Caller, ProcessContext } from "./context";
import { isMembershipInactive, MEMBERSHIP_INACTIVE, ProcessError, type ProcessErrorCode } from "./errors";
import { asProcessError, CONTINUABLE_CODES, ledgerOrStockEvent, ledgerOrStockReason, NESTED_RETRY_PROCESS, nestedPolicy, observeEmits, queuedReason, reportEmitted } from "./nested-policy";

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
   * idempotency row is written. A denial is still audited (except in the assistant's `preflight`); an idempotency key already stored answers its stored
   * result, as a real run would. The importer validates rows this way (Task 13b). Only what the handler does in
   * `ctx.tx` is undone: handlers read `ctx.dryRun` and skip any effect outside the database.
   */
  dryRun?: boolean;
  /**
   * Marks a dry run as the assistant's preflight before a confirmation card (rule 16 second exception, design §22.28). Only
   * `packages/agent/src/runtime/confirm.ts` sets it: a denial of such a run writes no audit row and is counted as telemetry. Any other dry
   * run (the import preview) audits its denials as a real run does. Ignored without `dryRun`.
   */
  preflight?: "assistant";
  /**
   * A dry run's events (plan 2B Task 25): called, before the rollback, with what the run (its nested runs and inline posting included)
   * put in the outbox, in order, so a confirmation card lists what the run would set off. Ignored without `dryRun`; not called on a refusal.
   */
  onDryRunEvents?: (events: { event: string; payload: unknown }[]) => void;
  /**
   * Idempotency key of this run when the process declares none (or instead of its own): a second run with the same
   * key in the company answers the first run's stored result without running again. The importer keys each row by
   * `import:<importId>:<rowIndex>`, so a retried batch replays instead of creating twice.
   */
  idempotencyKey?: string;
  /**
   * The record this creation was cloned from (rule 37, design §22.13): a `create` process only. The run's audit entry
   * and the row trigger's insert entries record it as `source_row_id`, so the viewer shows "clonado desde …". Anything
   * but a record id, or a process of another kind (or one that creates no registered entity), is refused as
   * `invalid_input`. The source must be a record of the created entity the caller sees: a role of theirs may consult the
   * entity and its masked view (company RLS, party scope) shows the row, checked as the caller in the run's
   * transaction before the handler; otherwise the run is refused as `not_found` (stage `gate`), whoever calls.
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

/**
 * The denial a nested run in a `continue` pair failed with when its cause is a SQL `insufficient_privilege` (42501): `forbidden`, so it
 * propagates and is never queued (plan 2B Task 32, fix round 1, M1). Outside `continue` the code stays as before (`handler_failed`).
 */
function sqlDenial(error: unknown, processId: string): ProcessError | undefined {
  const sqlState = (e: unknown) => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);
  const cause = error instanceof ProcessError ? (error as { cause?: unknown }).cause : error;
  if (sqlState(cause) !== "42501") return undefined;
  return new ProcessError("forbidden", `process ${processId} was refused by the database (insufficient privilege)`, { cause });
}

/** Refusals recorded in the audit log with action `denied` (design §5.4 step 2). */
const DENIALS = new Set<ProcessErrorCode>(["not_entitled", "forbidden", "step_up_required", "record_forbidden"]);

/**
 * Runs a registered process for `caller` (design §5.4). In order: resolve (`not_found`),
 * entitlements (`not_entitled`), an inactive membership (`forbidden` with `details.reason` MEMBERSHIP_INACTIVE),
 * permission (`forbidden`, skipped for `permission: "none"`), step-up (`step_up_required`), input
 * (`invalid_input`), idempotent replay, then one transaction as the caller holding the step-up
 * consumption, the handler, its outbox events, the audit row and the idempotency record. A handler
 * error rolls all of it back and surfaces as `handler_failed`, except a `ProcessError` the handler
 * throws itself, which keeps its code (a denial code is then audited like any other denial), and a SQL refusal raised
 * with the `SQL_INVALID_INPUT` prefix, which becomes `invalid_input`. A denial is audited (action `denied`, except in the assistant's preflight dry run: counted, not audited, rule 16)
 * in its own committed transaction, on the attempt's chain. With `options.dryRun` the transaction is always
 * rolled back after the handler (see `RunProcessOptions`).
 *
 * After the commit, the `ctx.afterCommit` steps run in order, each in its own transaction as the caller; one that throws is
 * audited on the chain (`input.code: "post_commit_failed"`) and the committed result is still returned. A replay answers the
 * stored result through `def.replay` when the process declares it. The result of `<entity>.update` on a maestro or documento
 * whose entity declares `updated_at` carries `updatedAt`: the ISO version that run wrote, read in its transaction (design §5.4).
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
      // A denial inside the assistant's preflight dry run (`options.preflight`) writes no audit row: it is counted (rule 16,
      // design §22.28, plan 2B Task 50.7). A denial of a real run is audited.
      const denial = { ...auditDefaults(def, caller, chainId), action: "denied" as const, input: { code: error.code, process_id: def.id } };
      // A deactivated membership's company is no longer in the caller's company_ids (0027), so their own session cannot
      // write that company's audit: the refusal is recorded on the service connection, still on their name.
      const asService = isMembershipInactive(error);
      const record = (tx: Tx) => (options.dryRun === true && options.preflight === "assistant" ? countDryRunDenial(tx, caller.claims.active_company_id, def.id, error.code) : writeAudit(tx, denial));
      if (asService) await deps.sql.begin(record);
      else await withClaims(deps.sql, caller.claims, record);
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

  if (def.origins && !def.origins.includes(caller.origin)) {
    throw new ProcessError("forbidden", `${def.id} runs only from ${def.origins.join(", ")}`, GATE);
  }
  if (def.nestedOnlyFrom) {
    throw new ProcessError("forbidden", `${def.id} runs only nested in ${def.nestedOnlyFrom.join(", ")}`, GATE);
  }

  const stepUpToken = caller.stepUpToken ?? null;
  const gate = await withClaims(deps.sql, claims, async (tx) => {
    const [row] = await tx<{ allowed: boolean; member: boolean; inactive: boolean; sensitive: boolean; verified: boolean }[]>`
      select
        kernel.can_run_process(${def.id}) as allowed,
        coalesce(kernel.current_company_id() = any (kernel.current_company_ids()), false) as member,
        kernel.membership_inactive() as inactive,
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
  // A deactivated membership (design §22.16) runs nothing, whatever the claims say: not a self-service process, not an
  // admin's (whose admin bypass already ends with the membership, 0025), checked here before anything else.
  if (gate.inactive) throw new ProcessError("forbidden", `the caller's membership in company ${companyId} is inactive`, { details: { reason: MEMBERSHIP_INACTIVE }, stage: "gate" });
  // A self-service process (`permission: "none"`) needs no row in the role matrix, only membership of the
  // active company; everything else needs a role that allows it.
  if (def.permission === "none" ? !gate.member : !gate.allowed) throw new ProcessError("forbidden", `no role of the caller may run ${def.id}`, GATE);
  const stepUp = gate.sensitive || def.sensitivity === "step-up";
  if (stepUp && !gate.verified) throw new ProcessError("step_up_required", `${def.id} requires a fresh step-up verification`, GATE);

  let cloned: ResolvedEntityDef | null = null;
  if (options.sourceRowId !== undefined) {
    if (def.kind !== "create") throw new ProcessError("invalid_input", `${def.id} creates nothing: it has no source record`, { details: ["Solo una creación tiene registro de origen"], stage: "gate" });
    if (!UUID.test(options.sourceRowId)) throw new ProcessError("invalid_input", `source record ${options.sourceRowId} is not a record id`, { details: ["El registro de origen no es válido"], stage: "gate" });
    cloned = createdEntity(deps.registry, def);
    if (!cloned) throw new ProcessError("invalid_input", `${def.id} creates no registered entity: it has no source record`, { details: ["Solo una creación tiene registro de origen"], stage: "gate" });
  }

  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    throw new ProcessError("invalid_input", `invalid input for ${def.id}`, { details: parsed.error.issues, stage: "gate" });
  }

  const key = options.idempotencyKey ?? def.idempotencyKey?.(parsed.data);
  if (key !== undefined) {
    const stored = await storedResult(deps.sql, claims, def, key);
    if (stored) return stored.result as z.infer<O>;
  }

  const after: Array<Parameters<NonNullable<ProcessContext["afterCommit"]>>[0]> = [];
  // The nested runs this run queued (a `continue` pair) are noted in its own success audit row (R32-9 ii).
  const nesting: NestingState = { collectors: [], queued: [] };
  try {
    const result = await withClaims(deps.sql, claims, async (tx) => {
      await setAuditContext(tx, {
        origin: caller.origin,
        processId: def.id,
        chainId,
        actorUserId: claims.sub,
        conversationId: caller.conversationId,
        sourceRowId: options.sourceRowId,
      });
      // The source of a clone is a record the caller sees (rule 37), asked as them before anything is written.
      if (cloned && options.sourceRowId !== undefined) await requireVisibleSource(tx, deps.registry, cloned, options.sourceRowId);
      if (stepUp) await consumeStepUp(tx, def.id, stepUpToken!, claims.sub, companyId);

      // The roles the caller still holds (0024: the claim's roles intersected with the live memberships), so a role
      // revoked after the token was issued no longer counts for the handler's own checks (custom-field roles).
      const [live] = await tx<{ role_ids: string[] }[]>`select kernel.current_role_ids() as role_ids`;
      const ctx = buildContext(tx, deps, def, caller, chainId, dryRun, live!.role_ids, 0, nesting);
      ctx.afterCommit = (fn) => {
        after.push(fn);
      };
      let output: unknown;
      try {
        // Record-level access (spec 2026-11-02 §9.1): a process that changes one maestro or documento needs the caller's right on it.
        const guard = recordGuardOf(deps.registry, def, parsed.data);
        if (guard) await assertRecordRight(ctx, guard.entity, guard.recordId, guard.right);
        output = await def.handler(ctx, parsed.data);
        if (guard && def.id === `${guard.entity}.update`) output = await withVersion(tx, deps.registry, guard.entity, guard.recordId, output);
      } catch (cause) {
        // A handler refuses with a typed error (e.g. invalid_input from a country-pack validator): keep it. So does a
        // SQL refusal raised with the SQL_INVALID_INPUT prefix.
        if (cause instanceof ProcessError) throw cause;
        throw sqlRefusal(cause) ?? new ProcessError("handler_failed", `process ${def.id} failed`, { cause });
      }
      // A dry run ends here: everything the handler wrote (and the step-up consumption) is rolled back.
      if (dryRun) {
        // This transaction's events on the chain (`created_at` is the transaction's `now()`; an earlier committed run's are not).
        if (options.onDryRunEvents) {
          options.onDryRunEvents(await tx<{ event: string; payload: unknown }[]>`
            select event, payload from kernel.outbox where chain_id = ${chainId} and created_at = now() order by id`);
        }
        throw new DryRunRollback(output);
      }

      await writeAudit(tx, {
        ...auditDefaults(def, caller, chainId),
        rowId: rowIdOf(output),
        input: withQueued(def.auditInput ? def.auditInput(parsed.data) : parsed.data, nesting.queued),
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
    // Committed: the effects the handler deferred (outside the database), each in its own transaction as the caller.
    const asCaller = <T>(work: (tx: Tx) => Promise<T>): Promise<T> =>
      withClaims(deps.sql, claims, async (tx) => {
        await setAuditContext(tx, { origin: caller.origin, processId: def.id, chainId, actorUserId: claims.sub, conversationId: caller.conversationId });
        return work(tx);
      });
    // The run is committed: a post-commit step that throws never turns it into an error for the caller. It is audited on the run's
    // chain in a transaction of its own (rule 16: `post_commit_failed`, the process, origin and actor), and the later steps still run.
    for (const fn of after) {
      try {
        await fn(asCaller);
      } catch (error) {
        console.error(`${def.id}: a post-commit step failed after the run committed (chain ${chainId})`, error);
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
        await asCaller((tx) => writeAudit(tx, { ...auditDefaults(def, caller, chainId), rowId: rowIdOf(result), input: { code: "post_commit_failed", message } })).catch((auditError: unknown) =>
          console.error(`${def.id}: auditing the post-commit failure failed (chain ${chainId})`, auditError),
        );
      }
    }
    return result;
  } catch (error) {
    if (error instanceof DryRunRollback) return error.output as z.infer<O>;
    if (key !== undefined && error instanceof ProcessError && error.code === "idempotent_replay") {
      const stored = await storedResult(deps.sql, claims, def, key);
      if (stored) return stored.result as z.infer<O>;
    }
    throw error;
  }
}

/**
 * Minor 9 (Phase 2A.5): the form save of a maestro or documento (`<entity>.update`) answers the version it wrote (`updatedAt`, read in
 * the run's transaction), so a lifecycle step chained to it («Guardar y enviar a aprobación») sends it as `expectedUpdatedAt`.
 */
async function withVersion(tx: Tx, registry: Registry, entityId: string, recordId: string, output: unknown): Promise<unknown> {
  if (typeof output !== "object" || output === null || (output as { id?: unknown }).id !== recordId || "updatedAt" in output) return output;
  const entity = registry.entities().find((e) => e.id === entityId);
  if (!entity || !entity.fields.some((f) => f.name === "updated_at") || !IDENTIFIER.test(entity.schema) || !IDENTIFIER.test(entity.table)) return output;
  const [row] = await tx.unsafe<{ updated_at: Date | null }[]>(`select updated_at from ${entity.schema}.${entity.table} where id = $1`, [recordId]);
  return row?.updated_at ? { ...output, updatedAt: new Date(row.updated_at).toISOString() } : output;
}

/** A record-level right (kernel.record_access, spec 2026-11-02 §9.1): maestro read/use/modify/delete, documento read/modify/void. */
export type RecordRight = "read" | "use" | "modify" | "delete" | "void";

/**
 * Refuses the step unless the caller holds `right` on record `recordId` of the maestro or documento `entity`
 * (`kernel.can_access_record`: always for a company admin, always for a record without rules, else only by a rule of their user or
 * one of their roles). A record the caller cannot read is refused exactly as one that does not exist (`not_found`, the lifecycle's own
 * message and no details), so the refusal never tells that it exists; one they read without the right is `record_forbidden` with
 * `details: { entity, recordId, right }`. The rule only narrows: runProcess has already checked the role's permission for the process.
 * Runs in the process transaction, as the caller.
 */
export async function assertRecordRight(ctx: Pick<ProcessContext, "tx">, entity: string, recordId: string, right: RecordRight): Promise<void> {
  if (!UUID.test(recordId)) return;
  const [row] = await ctx.tx<{ readable: boolean; allowed: boolean }[]>`
    select kernel.can_access_record(${entity}, ${recordId}::uuid, 'read') as readable,
           kernel.can_access_record(${entity}, ${recordId}::uuid, ${right}) as allowed`;
  if (row?.readable !== true) throw new ProcessError("not_found", `${entity} ${recordId} not found`);
  if (row.allowed !== true) {
    throw new ProcessError("record_forbidden", `the caller has no ${right} right on ${entity} ${recordId}`, { details: { entity, recordId, right } });
  }
}

/**
 * The record right a process run needs, if any: a process of kind update or delete named `<entity>.<verb>` whose entity is a
 * maestro or documento and whose input names the record (`id`). `void` (Anular) needs void; `delete` (Eliminar) needs delete on a
 * maestro and modify on a documento (a Borrador only, D1; a documento has no delete right); every other verb (Grabar, Enviar,
 * Aprobar, No Aprobar, the module's own updates) needs modify. Reads are RLS's (the record read policy, 0044).
 */
export function recordGuardOf(registry: Registry, def: ProcessDef, input: unknown): { entity: string; recordId: string; right: RecordRight } | null {
  const declared = def.recordAccess;
  if (declared === "handler" || declared === "none") return null;
  if (declared) {
    const recordId = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[declared.idField] : undefined;
    return typeof recordId === "string" && UUID.test(recordId) ? { entity: declared.entity, recordId, right: declared.right } : null;
  }
  const convention = conventionTarget(registry, def);
  if (!convention) return null;
  const recordId = typeof input === "object" && input !== null ? (input as { id?: unknown }).id : undefined;
  if (typeof recordId !== "string" || !UUID.test(recordId)) return null;
  return { entity: convention.entity, recordId, right: convention.right };
}

/** The name convention's target: an update or delete process `<entity>.<verb>` of a maestro or documento. */
function conventionTarget(registry: Registry, def: ProcessDef): { entity: string; right: RecordRight } | null {
  if (def.kind !== "update" && def.kind !== "delete") return null;
  const cut = def.id.lastIndexOf(".");
  if (cut <= 0) return null;
  const entityId = def.id.slice(0, cut);
  const verb = def.id.slice(cut + 1);
  const entity = registry.entities().find((e) => e.id === entityId);
  if (!entity || entity.kind === "query" || (entity.entityType !== "maestro" && entity.entityType !== "documento")) return null;
  // Only an actual delete needs the delete right; deactivate / activate are state changes (modify), ruling of 2026-11-02.
  const right: RecordRight = verb === "void" ? "void" : verb === "delete" && entity.entityType === "maestro" ? "delete" : "modify";
  return { entity: entity.id, right };
}

/**
 * The processes that may change a maestro or documento without a record guard (review I4): create / update / delete processes that
 * neither follow the name convention nor create their entity, and declare no `recordAccess`, among the processes of a module that
 * owns a maestro or documento and the processes whose input names a record by `entity` + `recordId`. A registry test keeps it empty.
 */
export function uncoveredRecordWrites(registry: Registry): string[] {
  const typedModules = new Set(
    registry.entities().filter((e) => e.kind !== "query" && (e.entityType === "maestro" || e.entityType === "documento")).map((e) => e.module),
  );
  const namesRecord = (def: ProcessDef) => {
    const shape = (def.input as { shape?: Record<string, unknown> }).shape;
    return !!shape && "entity" in shape && "recordId" in shape;
  };
  return registry
    .processes()
    .filter((def) => def.kind !== "consult" && def.recordAccess === undefined)
    .filter((def) => typedModules.has(def.module) || namesRecord(def))
    .filter((def) => !conventionTarget(registry, def) && !createdEntity(registry, def))
    .map((def) => def.id)
    .sort();
}

/** The registered entity a create process creates: the one whose create process it is (`processIds.create`, else `<entity>.create`). */
function createdEntity(registry: Registry, def: ProcessDef): ResolvedEntityDef | null {
  return registry.entities().find((entity) => (entity.processIds?.create ?? `${entity.id}.create`) === def.id) ?? null;
}

/**
 * Refuses (`not_found`, stage `gate`) a clone whose source the caller does not see: no role of theirs may consult the
 * entity, or its masked view (`<schema>.v_<table>`: company RLS, the party scope) does not show the row. As the caller.
 */
async function requireVisibleSource(tx: Tx, registry: Registry, entity: ResolvedEntityDef, sourceRowId: string): Promise<void> {
  for (const part of [entity.schema, entity.table]) if (!IDENTIFIER.test(part)) throw new Error(`entity ${entity.id}: invalid identifier "${part}"`);
  const consults = consultProcessesOf(registry, entity);
  const [row] = await tx.unsafe<{ visible: boolean }[]>(
    `select coalesce((select bool_or(kernel.can_run_process(p)) from unnest($1::text[]) as p), false)
            and exists (select 1 from ${entity.schema}.v_${entity.table} where id = $2::uuid) as visible`,
    [consults, sourceRowId] as never[],
  );
  if (!row?.visible) {
    throw new ProcessError("not_found", `source record ${sourceRowId} of ${entity.id} does not exist or is not visible to the caller`, {
      details: ["El registro de origen no existe o no es visible"],
      stage: "gate",
    });
  }
}

function resolve(registry: Registry, processId: string): ProcessDef {
  try {
    return registry.process(processId);
  } catch {
    throw new ProcessError("not_found", `unknown process: ${processId}`, GATE);
  }
}

async function storedResult(sql: Sql, claims: JwtClaims, def: ProcessDef, key: string) {
  return withClaims(sql, claims, async (tx) => {
    const [row] = await tx<{ result: unknown }[]>`
      select result from kernel.process_idempotency
      where company_id = ${claims.active_company_id} and process_id = ${def.id} and key = ${key}`;
    if (row && def.replay) row.result = await def.replay(tx, row.result as never);
    return row;
  });
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

/** A nested run that failed and was queued (a `continue` pair): noted in its parent's success audit row as `nested_queued`. */
interface QueuedNested {
  process: string;
  failure_id: string;
}

/** What one context of a run shares with the runs nested in it (plan 2B Task 32). */
interface NestingState {
  /** Event collectors of the `continue` subtrees this context is in: each event it writes is reported to all of them (R32-5). */
  collectors: string[][];
  /** The nested runs of this context that failed and were queued. */
  queued: QueuedNested[];
}

/** The audit input of a run, with the nested runs it queued merged in when there are any (R32-9 ii); unchanged otherwise. */
function withQueued(input: unknown, queued: QueuedNested[]): unknown {
  if (queued.length === 0) return input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return { ...(input as Record<string, unknown>), nested_queued: queued };
  return { input, nested_queued: queued };
}

/** Process ids are identifiers of dotted lowercase segments; a savepoint name is built from a depth only. */
const savepointName = (depth: number) => `nested_run_${Math.trunc(depth)}`;

function buildContext(
  tx: Tx,
  deps: RunProcessDeps,
  def: ProcessDef,
  caller: Caller,
  chainId: string,
  dryRun: boolean,
  roleIds: string[],
  depth: number,
  nesting: NestingState = { collectors: [], queued: [] },
): ProcessContext {
  const { claims } = caller;
  const registry = deps.registry;
  const ctx: ProcessContext = {
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
    recommendations: makeRecommendations(tx, registry, def.id),
    links: makeLinks(tx, registry, def.id),
    async emit(event, payload) {
      await enqueueEvent(tx, { companyId: claims.active_company_id, event, payload, chainId });
      reportEmitted(ctx, event);
    },
    async audit(entry) {
      // The handler may describe the entry, never change who did it or from where.
      const defaults = auditDefaults(def, caller, chainId);
      const { companyId, actorUserId, origin } = defaults;
      await writeAudit(tx, { ...defaults, ...entry, companyId, actorUserId, origin });
    },
    async runProcess<T>(processId: string, input: unknown, opts: { asParent?: string } = {}): Promise<T | undefined> {
      // `asParent` (R32-8): only the queue's retry replays a nested run in its original parent's pair context.
      let parentId = def.id;
      if (opts.asParent !== undefined) {
        if (def.id !== NESTED_RETRY_PROCESS) throw new ProcessError("forbidden", `${def.id} may not run a nested process as another parent`, GATE);
        parentId = resolve(registry, opts.asParent).id;
      }
      // The pair's policy and the company's depth (defaults with no configuration: depth 4, no coverage, roll back all).
      const policy = await nestedPolicy(tx, parentId, processId);
      if (depth >= policy.maxDepth) throw new ProcessError("handler_failed", `${def.id}: nested runs are limited to ${policy.maxDepth} levels`);
      const inner = resolve(registry, processId);
      const companyId = claims.active_company_id;
      if (inner.module !== "kernel" && !(await (deps.entitled ?? resolveEntitled)(deps.sql, companyId, `process:${inner.id}`))) {
        throw new ProcessError("not_entitled", `process ${inner.id} is not entitled for company ${companyId}`, GATE);
      }
      if (inner.origins && !inner.origins.includes(caller.origin)) throw new ProcessError("forbidden", `${inner.id} runs only from ${inner.origins.join(", ")}`, GATE);
      if (inner.nestedOnlyFrom && !inner.nestedOnlyFrom.includes(parentId)) throw new ProcessError("forbidden", `${inner.id} runs only nested in ${inner.nestedOnlyFrom.join(", ")}`, GATE);
      // Step-up coverage (R32-4): the caller's token covers the nested process only when it is a fresh verification of this user that this
      // very transaction consumed (`consumed_at = now()`: the step-up parent's own run), and only for a pair the admin switched on.
      const stepUpToken = caller.stepUpToken ?? null;
      const [gate] = await tx<{ allowed: boolean; parent_allowed: boolean; member: boolean; sensitive: boolean; covered: boolean }[]>`
        select kernel.can_run_process(${inner.id}) as allowed,
               kernel.can_run_process(${parentId}) as parent_allowed,
               coalesce(kernel.current_company_id() = any (kernel.current_company_ids()), false) as member,
               exists (select 1 from kernel.sensitive_processes sp where sp.company_id = ${companyId} and sp.process_id = ${inner.id}) as sensitive,
               ${policy.totpCovers} and exists (
                 select 1 from kernel.step_up_verifications v
                 where v.token = ${stepUpToken} and v.user_id = ${claims.sub} and v.company_id = ${companyId}
                   and v.verified_at > now() - interval '5 minutes' and v.consumed_at = now()
               ) as covered`;
      // A process that runs only nested in named parents is covered by its parent's role gate (the admin's matrix never lists it).
      if (inner.permission === "none" || inner.nestedOnlyFrom ? !gate!.member : !gate!.allowed) throw new ProcessError("forbidden", `no role of the caller may run ${inner.id}`, GATE);
      // A replay as another parent (the queue's retry) of a process the parent's role gate covers (nestedOnlyFrom, permission "none") needs
      // the retrying user to be able to run that parent: the retry grant alone never stands in for it (fix round 1, I2).
      if (opts.asParent !== undefined && (inner.permission === "none" || inner.nestedOnlyFrom) && !gate!.parent_allowed) {
        throw new ProcessError("forbidden", `no role of the caller may run ${parentId}, the parent ${inner.id} is replayed in`, GATE);
      }
      if ((gate!.sensitive || inner.sensitivity === "step-up") && !gate!.covered) {
        throw new ProcessError("step_up_required", `${inner.id} requires its own step-up verification and cannot run nested in ${def.id}`, GATE);
      }
      const parsed = inner.input.safeParse(input);
      if (!parsed.success) throw new ProcessError("invalid_input", `invalid input for ${inner.id}`, { details: parsed.error.issues, stage: "gate" });

      // Continue and queue (R32-5, R32-6): never for a retry, never for a process that posts to the ledger or moves stock (a stored
      // `continue` of such a pair runs as rollback, with an audit note).
      let continueMode = policy.onFailure === "continue" && opts.asParent === undefined;
      const ledgerOrStock = continueMode ? ledgerOrStockReason(registry, inner.id) : null;
      if (ledgerOrStock !== null) {
        continueMode = false;
        await writeAudit(tx, { ...auditDefaults(def, caller, chainId), input: { code: "nested_continue_refused", nested_process: inner.id, reason: ledgerOrStock } });
      }
      const collected: string[] = [];
      const nestedQueued: QueuedNested[] = [];
      // In a `continue` subtree the nested run's deferred steps wait for its success, so a savepoint rollback drops them too.
      const deferred: Array<Parameters<NonNullable<ProcessContext["afterCommit"]>>[0]> = [];
      const attribute = (on: Tx, id: string) => setAuditContext(on, { origin: caller.origin, processId: id, chainId, actorUserId: claims.sub, conversationId: caller.conversationId });
      /** The nested run itself, on `on`: the outer transaction, or the savepoint a `continue` pair opens around it. */
      const body = async (on: Tx): Promise<unknown> => {
        const nested = buildContext(on, deps, inner, caller, chainId, ctx.dryRun, roleIds, depth + 1, {
          collectors: continueMode ? [...nesting.collectors, collected] : nesting.collectors,
          queued: nestedQueued,
        });
        nested.afterCommit = continueMode ? (fn) => void deferred.push(fn) : ctx.afterCommit;
        await attribute(on, inner.id);
        let output: unknown;
        try {
          const guard = recordGuardOf(registry, inner, parsed.data);
          if (guard) await assertRecordRight(nested, guard.entity, guard.recordId, guard.right);
          output = await inner.handler(nested, parsed.data);
        } catch (cause) {
          if (cause instanceof ProcessError) throw cause;
          throw sqlRefusal(cause) ?? new ProcessError("handler_failed", `process ${inner.id} failed`, { cause });
        }
        await writeAudit(on, { ...auditDefaults(inner, caller, chainId), rowId: rowIdOf(output), input: withQueued(inner.auditInput ? inner.auditInput(parsed.data) : parsed.data, nestedQueued) });
        return output;
      };

      if (!continueMode) {
        let failed = false;
        try {
          return (await body(tx)) as T;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          // The rest of the outer run is attributed to the outer process again, also when the nested run threw and the outer handler catches
          // it (final review M-3). After a SQL error the transaction is aborted and this cannot run: the nested error is the one that counts.
          await attribute(tx, def.id).catch((error: unknown) => {
            if (!failed) throw error;
          });
        }
      }

      // Continue and queue (R32-6): the nested run happens inside a savepoint (named per depth; the driver's own scope, so a SQL error of
      // the nested run is contained in it and does not abort the outer transaction). On failure only the nested run is undone: its writes,
      // audit, outbox, links and the audit context it set (set_config reverts with the savepoint), and its deferred steps are dropped.
      let output: unknown;
      try {
        output = await tx.savepoint(savepointName(depth + 1), (sp) => body(sp as unknown as Tx));
      } catch (error) {
        await attribute(tx, def.id);
        // A SQL denial (insufficient_privilege, 42501: a definer writer or a grant refusing this run) is a denial like the typed ones (M1).
        const failure = sqlDenial(error, inner.id) ?? asProcessError(sqlRefusal(error) ?? error, inner.id);
        // A denial always propagates (R32-16); so does a failure after the subtree set off a ledger or stock event (R32-5 run-time guard).
        if (!CONTINUABLE_CODES.has(failure.code) || collected.some((event) => ledgerOrStockEvent(registry, event))) throw failure;
        const [row] = await tx<{ id: string }[]>`
          select kernel.nested_failure_record(${def.id}, ${inner.id}, ${tx.json((parsed.data ?? null) as JSONValue)}, ${failure.code}, ${queuedReason(failure)},
                                              ${chainId}::uuid, ${caller.origin}) as id`;
        const failureId = row!.id;
        await writeAudit(tx, { ...auditDefaults(inner, caller, chainId), input: { code: "nested_run_queued", error_code: failure.code, failure_id: failureId } });
        await writeAudit(tx, { ...auditDefaults(def, caller, chainId), input: { code: "nested_run_queued", nested_process: inner.id, failure_id: failureId } });
        nesting.queued.push({ process: inner.id, failure_id: failureId });
        return undefined;
      }
      await attribute(tx, def.id);
      for (const fn of deferred) ctx.afterCommit?.(fn);
      return output as T;
    },
  };
  // Every event this context writes is reported to the collectors of the `continue` subtrees it is in (R32-5 run-time guard).
  if (nesting.collectors.length > 0) observeEmits(ctx, (event) => {
    for (const collector of nesting.collectors) collector.push(event);
  });
  return ctx;
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
