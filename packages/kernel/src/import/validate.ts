import { withClaims } from "../db/client";
import type { Caller } from "../process/context";
import { ProcessError } from "../process/errors";
import { runProcess, type RunProcessDeps } from "../process/run";
import type { ResolvedEntityDef } from "../registry/entities";
import { entityModuleOf, IDENTIFIER } from "../registry/fields";
import type { ImportColumn, ImportLines } from "./columns";
import { describeFailure } from "./errors-csv";
import { columnLabel, lineLabels, linePrefix, type ImportLabels, type ImportRecord } from "./map";

// Validating and creating import rows as the caller (design §5.11 "validate" and "commit"). Reference columns take
// the target's display value ("Café" for a category) and are resolved through the target's masked view under the
// caller's claims, so a row can only point at records the caller sees. Every row then runs the entity's create
// process: in a dry run to validate, for real to create.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RowOutcome {
  /** Index of the record in the mapped sheet. */
  index: number;
  rowNo: number;
  ok: boolean;
  errors: string[];
}

/** One reference cell to resolve: where its value lives, and where its error goes. */
interface RefCell {
  holder: Record<string, unknown>;
  record: ImportRecord;
  /** "Líneas, fila 7: " for a line's cell, "" for the header's. */
  prefix: string;
}

/**
 * Replaces each reference cell written as a display value by the id of the one visible record that has it; no
 * match or several matches are row errors. Ids are left to the create process. A documento's lines (D14, `lines`) are resolved the
 * same way, each error named by its Líneas row. A column to an entity of a module that is not loaded is left as it came (Task 53.2).
 */
export async function resolveReferences(
  deps: RunProcessDeps,
  caller: Caller,
  columns: ImportColumn[],
  records: ImportRecord[],
  labels: ImportLabels = {},
  lines: ImportLines | null = null,
): Promise<void> {
  const groups: { column: ImportColumn; label: string; cells: RefCell[] }[] = [];
  // A column whose target is an entity of a module that is not loaded (an optional neighbour, plan 2B Task 53.2) is not resolved: the
  // cell keeps the text it came with and the create process judges it. One of a loaded module resolves (an unknown entity throws).
  const resolvable = (c: ImportColumn) => c.type === "ref" && c.ref !== undefined && deps.registry.hasModule(entityModuleOf(c.ref.entity));
  for (const column of columns.filter(resolvable)) {
    groups.push({ column, label: columnLabel(column, labels), cells: records.map((record) => ({ holder: record.input, record, prefix: "" })) });
  }
  if (lines) {
    const ofLines = lineLabels(labels);
    for (const column of lines.columns.filter(resolvable)) {
      const cells = records.flatMap((record) => {
        const list = record.input[lines.key];
        if (!Array.isArray(list)) return [];
        return (list as Record<string, unknown>[]).map((holder, i) => ({ holder, record, prefix: linePrefix(record.lineRows?.[i] ?? 0) }));
      });
      groups.push({ column, label: columnLabel(column, ofLines), cells });
    }
  }
  if (groups.length === 0) return;
  await withClaims(deps.sql, caller.claims, async (tx) => {
    for (const { column, label, cells } of groups) {
      const names = [...new Set(cells.map((c) => c.holder[column.key]).filter((v): v is string => typeof v === "string" && !UUID.test(v)))];
      if (names.length === 0) continue;
      const target = deps.registry.entity(column.ref!.entity);
      const view = tx(`${target.schema}.v_${target.table}`);
      const display = tx(column.ref!.display);
      const found = await tx<{ id: string; display: string }[]>`
        select id, ${display}::text as display from ${view} where lower(${display}::text) = any(${names.map((n) => n.toLowerCase())}::text[])`;
      const ids = new Map<string, string[]>();
      for (const row of found) ids.set(row.display.toLowerCase(), [...(ids.get(row.display.toLowerCase()) ?? []), row.id]);
      for (const { holder, record, prefix } of cells) {
        const value = holder[column.key];
        if (typeof value !== "string" || UUID.test(value)) continue;
        const matches = ids.get(value.toLowerCase()) ?? [];
        if (matches.length === 1) holder[column.key] = matches[0];
        else record.errors.push(`${prefix}${label}: «${value}» ${matches.length === 0 ? "no existe" : "corresponde a varios registros"}`);
      }
    }
  });
}

/**
 * Refusals of the caller by the pipeline (`stage: "gate"`): the same for every row, so the first one stops the run
 * (one denial, not one per row). The same codes thrown by the handler are about the row (a party kind outside the
 * caller's scope) and only refuse that row.
 */
const STOPS = new Set(["step_up_required", "forbidden", "not_entitled"]);

export interface RecordsRun {
  outcomes: RowOutcome[];
  /** The denial that stopped the run (`step_up_required`, `forbidden`, `not_entitled`); the rows after it did not run. */
  stoppedBy?: string;
}

/** What a run of records knows of the target: its entity (import key, lifecycle) and a documento's lines layout. */
export interface RecordsTarget {
  entity: ResolvedEntityDef;
  lines?: ImportLines | null;
}

/**
 * Runs the create process for each record, as `caller`, one at a time and in file order: a dry run with
 * `dryRun`, for real otherwise. A record that already carries errors is not run. Refusals become the row's errors,
 * except a denial of the caller, which stops at once (`stoppedBy`). `keyOf` gives a record's idempotency key, so a
 * rerun of the same records replays their stored results instead of creating them again.
 *
 * Typed entities (entity types spec §2.5, §10.2; Task 13), with `options.target`:
 * - A maestro created for real then follows the lifecycle as the screen's Grabar does, through its registered processes: a Borrador
 *   is saved (`<entity>.save`, Grabado) and a Grabado that requires approval is sent to approval (`<entity>.submit`, Pendiente de
 *   Aprobación). A documento stays as its create process left it (Borrador, with its lines). Nothing is ever approved or posted.
 * - A row refused because its value is already taken (a unique violation) while no record the caller may read has it on the import
 *   key, i.e. it belongs to a record hidden by record access (Task 9 M4 ruling), is refused with the generic "Ya existe un registro con
 *   ese valor", which tells nothing of that record; the module's own refusal is kept when the caller sees the record.
 */
export async function runRecords(
  deps: RunProcessDeps,
  caller: Caller,
  processId: string,
  columns: ImportColumn[],
  records: { index: number; record: ImportRecord }[],
  options: { dryRun: boolean; labels?: ImportLabels; keyOf?: (index: number) => string; target?: RecordsTarget },
): Promise<RecordsRun> {
  const outcomes: RowOutcome[] = [];
  const target = options.target;
  const lines = target?.lines ?? null;
  for (const { index, record } of records) {
    if (record.errors.length > 0) {
      outcomes.push({ index, rowNo: record.rowNo, ok: false, errors: [...record.errors] });
      continue;
    }
    const key = options.keyOf?.(index);
    let created: unknown;
    try {
      created = await runProcess(deps, caller, processId, record.input, { dryRun: options.dryRun, idempotencyKey: key });
    } catch (error) {
      if (error instanceof ProcessError && error.stage === "gate" && STOPS.has(error.code)) return { outcomes, stoppedBy: error.code };
      // The user reads «No se pudo crear el registro»; the cause stays in the server log.
      if (!(error instanceof ProcessError) || error.code === "handler_failed") console.error(`import row ${record.rowNo} of ${processId} failed:`, error instanceof ProcessError ? error.cause : error);
      const described = describeFailure(error, columns, options.labels, record.input, lines ? { layout: lines, rowNos: record.lineRows ?? [] } : undefined);
      const errors = target && isUniqueViolation(error) ? await duplicateRefusal(deps, caller, target.entity, columns, record, described, error, options.labels) : described;
      outcomes.push({ index, rowNo: record.rowNo, ok: false, errors });
      continue;
    }
    if (!options.dryRun && target && followsLifecycle(target.entity)) {
      const id = typeof created === "object" && created !== null ? (created as { id?: unknown }).id : undefined;
      const failure = typeof id === "string" ? await followLifecycle(deps, caller, target.entity, id, key, columns, options.labels) : null;
      if (failure) {
        outcomes.push({ index, rowNo: record.rowNo, ok: false, errors: failure });
        continue;
      }
    }
    outcomes.push({ index, rowNo: record.rowNo, ok: true, errors: [] });
  }
  return { outcomes };
}

/** A maestro whose records carry the lifecycle state (its `status` field, `kernel.typed_columns`): the import then follows it. */
const followsLifecycle = (entity: ResolvedEntityDef) => entity.entityType === "maestro" && entity.fields.some((f) => f.name === "status");

/** SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

/** The unique violation `error` carries (itself or an error it was caused by): the constraint that refused the value, when named. */
function uniqueViolation(error: unknown): { constraint?: string } | null {
  for (let at: unknown = error, depth = 0; at && depth < 5; at = (at as { cause?: unknown }).cause, depth++) {
    if (typeof at === "object" && (at as { code?: unknown }).code === UNIQUE_VIOLATION) {
      const name = (at as { constraint_name?: unknown }).constraint_name;
      return typeof name === "string" && name !== "" ? { constraint: name } : {};
    }
  }
  return null;
}
const isUniqueViolation = (error: unknown) => uniqueViolation(error) !== null;

/** The generic refusal of a value a record hidden from the caller holds (Task 9 M4 ruling): no name, link or data of that record. */
export const TAKEN_VALUE = "Ya existe un registro con ese valor";

/**
 * The entity fields the unique constraint (or unique index) `name` of the entity's table covers, the company excepted, read from the
 * catalogue (`lower(name)` counts as `name`). Null when a key part names no field of the entity: the duplicate cannot be judged.
 */
async function constraintFields(deps: RunProcessDeps, caller: Caller, entity: ResolvedEntityDef, name: string): Promise<string[] | null> {
  const parts = await withClaims(deps.sql, caller.claims, (tx) =>
    tx<{ def: string }[]>`
      select pg_get_indexdef(i.indexrelid, k, true) as def
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral generate_series(1, i.indnkeyatts) as k
      where n.nspname = ${entity.schema} and c.relname = ${name}
      order by k`,
  );
  if (parts.length === 0) return null;
  const names = entity.fields.map((f) => f.name);
  const fields: string[] = [];
  for (const { def } of parts) {
    if (def === "company_id") continue;
    const found = names.filter((field) => new RegExp(`(^|[^a-z0-9_])${field}($|[^a-z0-9_])`).test(def));
    if (found.length !== 1) return null;
    fields.push(found[0]!);
  }
  return fields.length > 0 ? fields : null;
}

/**
 * Why a duplicate row is refused. The key is the unique constraint that actually refused the value (m4), else the entity's import key.
 * When a record the caller may read (its masked view, under their claims: company, record access, party scope) has the row's values on
 * that key, the module's own refusal stands (a generic database failure is named by the key's columns); otherwise the value belongs to
 * a record hidden from them, and only the bare fact is told.
 */
async function duplicateRefusal(
  deps: RunProcessDeps,
  caller: Caller,
  entity: ResolvedEntityDef,
  columns: ImportColumn[],
  record: ImportRecord,
  described: string[],
  error: unknown,
  labels: ImportLabels = {},
): Promise<string[]> {
  const fired = uniqueViolation(error)?.constraint;
  const key = fired ? await constraintFields(deps, caller, entity, fired) : (entity.importKey ?? null);
  if (!key?.length) return [TAKEN_VALUE];
  const keyColumns = key.map((field) => columns.find((c) => c.field === field));
  const values = keyColumns.map((c) => (c ? record.input[c.key] : undefined));
  const complete = keyColumns.every((c) => c !== undefined) && values.every((v) => v !== undefined && v !== null && String(v).trim() !== "");
  if (!complete || !(await visibleWithKey(deps, caller, entity, key, values.map(String)))) return [TAKEN_VALUE];
  if (described.length === 1 && described[0] === "No se pudo crear el registro") {
    return [`${keyColumns.map((c) => columnLabel(c!, labels)).join(", ")}: ${TAKEN_VALUE.charAt(0).toLowerCase()}${TAKEN_VALUE.slice(1)}`];
  }
  return described;
}

/** Whether a record of `entity` the caller may read has `values` on its import key `fields` (case and surrounding spaces ignored). */
async function visibleWithKey(deps: RunProcessDeps, caller: Caller, entity: ResolvedEntityDef, fields: string[], values: string[]): Promise<boolean> {
  for (const part of [entity.schema, entity.table, ...fields]) if (!IDENTIFIER.test(part)) throw new Error(`entity ${entity.id}: invalid identifier "${part}"`);
  const where = fields.map((f, i) => `lower(btrim(${f}::text)) = lower(btrim($${i + 1}))`).join(" and ");
  const [row] = await withClaims(deps.sql, caller.claims, (tx) =>
    tx.unsafe<{ found: boolean }[]>(`select exists (select 1 from ${entity.schema}.v_${entity.table} where ${where}) as found`, values as never[]),
  );
  return row?.found === true;
}

/**
 * What the screen's Grabar does after a maestro is created (spec §10.2: imported maestros land Grabado, or Pendiente de Aprobación
 * when they require approval), through the entity's registered lifecycle processes as the caller, on the import's chain: Grabar a
 * Borrador, then Enviar a aprobación a Grabado that requires approval. A module whose create already writes Grabado or Pendiente
 * needs neither. Returns the row's errors when a step was refused (the record stays as created), else null.
 */
async function followLifecycle(
  deps: RunProcessDeps,
  caller: Caller,
  entity: ResolvedEntityDef,
  id: string,
  key: string | undefined,
  columns: ImportColumn[],
  labels?: ImportLabels,
): Promise<string[] | null> {
  for (const part of [entity.schema, entity.table]) if (!IDENTIFIER.test(part)) throw new Error(`entity ${entity.id}: invalid identifier "${part}"`);
  const state = async () => {
    const [row] = await withClaims(deps.sql, caller.claims, (tx) =>
      tx.unsafe<{ status: string; requires_approval: boolean }[]>(`select status, requires_approval from ${entity.schema}.${entity.table} where id = $1`, [id]),
    );
    return row;
  };
  const step = async (verb: "save" | "submit") => {
    try {
      await runProcess(deps, caller, `${entity.id}.${verb}`, { id }, key === undefined ? {} : { idempotencyKey: `${key}:${verb}` });
      return null;
    } catch (error) {
      const why = describeFailure(error, columns, labels);
      return why.map((text) => `${verb === "save" ? "Creado en Borrador, no se pudo grabar" : "Grabado, no se pudo enviar a aprobación"}: ${text}`);
    }
  };
  let row = await state();
  if (row?.status === "draft") {
    const refused = await step("save");
    if (refused) return refused;
    row = await state();
  }
  if (row?.status === "saved" && row.requires_approval === true) return step("submit");
  return null;
}
