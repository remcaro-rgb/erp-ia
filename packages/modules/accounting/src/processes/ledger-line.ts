import { defineProcess, GridState, gridQueryInTx, ProcessError, QueryError } from "@erp/kernel";
import { z } from "zod";
import { id } from "./schemas";

// Movimientos (accounting design §4.16, §5.14): the `accounting.ledger_line` query entity has no table, so its grid opens
// through `accounting.ledger_line.list` (the entity's consult process, `consultProcessesOf`). Both processes read the masked
// view `v_ledger_lines` through the grid layer, as the caller: company RLS, account security (a restricted account leaves no
// line and no amount in any group or total) and field modes apply, the same as the grid route and `kernel.data.query`.

const ENTITY = "accounting.ledger_line";

const groupSchema = z.object({ level: z.number(), keys: z.record(z.string(), z.unknown()), count: z.number(), aggregates: z.record(z.string(), z.unknown()) });

/** The grid layer's refusals as the process answers them: a hidden or masked field is a denial, the rest a bad request. */
function asProcessError(error: unknown): unknown {
  if (error instanceof QueryError) {
    return new ProcessError(error.code === "field_hidden" ? "forbidden" : "invalid_input", error.message, { details: { reason: error.code, field: error.field } });
  }
  return error;
}

export const ledgerLineList = defineProcess({
  id: "accounting.ledger_line.list",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Consulta las líneas de comprobantes (Movimientos): filtros, orden, columnas, agrupación y agregados, sin las cuentas restringidas para quien no tiene acceso",
  input: z.object({ state: GridState }).strict(),
  output: z.object({
    rows: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
    aggregates: z.record(z.string(), z.unknown()).optional(),
    groups: z.array(groupSchema).optional(),
  }),
  handler: async (ctx, input) => {
    const entity = ctx.registry.entity(ENTITY);
    try {
      const { rows, total, aggregates, groups } = await gridQueryInTx(ctx.tx, entity, input.state, { registry: ctx.registry });
      return { rows, total, ...(aggregates ? { aggregates } : {}), ...(groups ? { groups } : {}) };
    } catch (error) {
      throw asProcessError(error);
    }
  },
});

export const ledgerLineConsult = defineProcess({
  id: "accounting.ledger_line.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Consulta una línea de comprobante por el comprobante y su número de línea",
  input: z.object({ entryId: id, lineNo: z.number().int().min(1) }).strict(),
  output: z.record(z.string(), z.unknown()),
  handler: async (ctx, input) => {
    const entity = ctx.registry.entity(ENTITY);
    const state = GridState.parse({
      filters: [{ field: "entry_id", op: "eq", value: input.entryId }, { field: "line_no", op: "eq", value: input.lineNo, join: "and" }],
      sort: [],
      page: 1,
      pageSize: 1,
    });
    try {
      const { rows } = await gridQueryInTx(ctx.tx, entity, state, { registry: ctx.registry });
      // A restricted line is not visible to the caller: it reads as absent, like a line that does not exist.
      if (!rows[0]) throw new ProcessError("invalid_input", `ledger line ${input.entryId}/${input.lineNo} not found`, { details: ["La línea no existe o no tienes acceso a ella"] });
      return rows[0];
    } catch (error) {
      throw asProcessError(error);
    }
  },
});

export const LEDGER_LINE_PROCESSES = [ledgerLineList, ledgerLineConsult];
