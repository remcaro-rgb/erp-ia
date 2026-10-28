import { withClaims } from "../db/client";
import type { Caller } from "../process/context";
import { ProcessError } from "../process/errors";
import { runProcess, type RunProcessDeps } from "../process/run";
import type { ImportColumn } from "./columns";
import { describeFailure } from "./errors-csv";
import { columnLabel, type ImportLabels, type ImportRecord } from "./map";

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

/**
 * Replaces each reference cell written as a display value by the id of the one visible record that has it; no
 * match or several matches are row errors. Ids are left to the create process.
 */
export async function resolveReferences(
  deps: RunProcessDeps,
  caller: Caller,
  columns: ImportColumn[],
  records: ImportRecord[],
  labels: ImportLabels = {},
): Promise<void> {
  const refColumns = columns.filter((c) => c.type === "ref" && c.ref);
  if (refColumns.length === 0) return;
  await withClaims(deps.sql, caller.claims, async (tx) => {
    for (const column of refColumns) {
      const names = [...new Set(records.map((r) => r.input[column.key]).filter((v): v is string => typeof v === "string" && !UUID.test(v)))];
      if (names.length === 0) continue;
      const target = deps.registry.entity(column.ref!.entity);
      const view = tx(`${target.schema}.v_${target.table}`);
      const display = tx(column.ref!.display);
      const found = await tx<{ id: string; display: string }[]>`
        select id, ${display}::text as display from ${view} where lower(${display}::text) = any(${names.map((n) => n.toLowerCase())}::text[])`;
      const ids = new Map<string, string[]>();
      for (const row of found) ids.set(row.display.toLowerCase(), [...(ids.get(row.display.toLowerCase()) ?? []), row.id]);
      const label = columnLabel(column, labels);
      for (const record of records) {
        const value = record.input[column.key];
        if (typeof value !== "string" || UUID.test(value)) continue;
        const matches = ids.get(value.toLowerCase()) ?? [];
        if (matches.length === 1) record.input[column.key] = matches[0];
        else record.errors.push(matches.length === 0 ? `${label}: «${value}» no existe` : `${label}: «${value}» corresponde a varios registros`);
      }
    }
  });
}

/** Refusals that are about the caller, not the row: the first one stops the run (one denial, not one per row). */
const STOPS = new Set(["step_up_required", "forbidden", "not_entitled"]);

export interface RecordsRun {
  outcomes: RowOutcome[];
  /** The denial that stopped the run (`step_up_required`, `forbidden`, `not_entitled`); the rows after it did not run. */
  stoppedBy?: string;
}

/**
 * Runs the create process for each record, as `caller`, one at a time and in file order: a dry run with
 * `dryRun`, for real otherwise. A record that already carries errors is not run. Refusals become the row's errors,
 * except a denial of the caller, which stops at once (`stoppedBy`). `keyOf` gives a record's idempotency key, so a
 * rerun of the same records replays their stored results instead of creating them again.
 */
export async function runRecords(
  deps: RunProcessDeps,
  caller: Caller,
  processId: string,
  columns: ImportColumn[],
  records: { index: number; record: ImportRecord }[],
  options: { dryRun: boolean; labels?: ImportLabels; keyOf?: (index: number) => string },
): Promise<RecordsRun> {
  const outcomes: RowOutcome[] = [];
  for (const { index, record } of records) {
    if (record.errors.length > 0) {
      outcomes.push({ index, rowNo: record.rowNo, ok: false, errors: [...record.errors] });
      continue;
    }
    try {
      await runProcess(deps, caller, processId, record.input, { dryRun: options.dryRun, idempotencyKey: options.keyOf?.(index) });
      outcomes.push({ index, rowNo: record.rowNo, ok: true, errors: [] });
    } catch (error) {
      if (error instanceof ProcessError && STOPS.has(error.code)) return { outcomes, stoppedBy: error.code };
      outcomes.push({ index, rowNo: record.rowNo, ok: false, errors: describeFailure(error, columns, options.labels, record.input) });
    }
  }
  return { outcomes };
}
