import { z } from "zod";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { gridEntity, requireGridAccess } from "./access";
import { QueryError } from "./errors";
import { GridState } from "./grid-state";
import { gridQueryInTx } from "./run";

// `kernel.data.query` (design §7.1 "Query", rules 1, 14 and 17): the assistant's way to read an entity's rows, as a
// registered consult process, so it is permissioned per role, entitled and audited (with the conversation) like any
// other. It reads what the entity's grid reads, through the same gate (entitled feature, the entity's own consult
// process allowed to a role of the caller) and the same query builder over the masked view, in the process
// transaction as the caller: company RLS, the party scope and field masking apply, and a hidden or masked field can be
// neither filtered nor sorted. At most `DATA_QUERY_MAX_ROWS` rows come back.

export const DATA_QUERY_MAX_ROWS = 50;
const FEATURE = "kernel.data";

const input = z.object({
  entity: z.string().min(1).max(100),
  filters: GridState.shape.filters.default([]),
  sort: GridState.shape.sort.default([]),
  columns: GridState.shape.columns,
  search: GridState.shape.search,
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(DATA_QUERY_MAX_ROWS).default(20),
});

export const dataQuery = defineProcess({
  id: "kernel.data.query",
  module: "kernel",
  kind: "consult",
  feature: FEATURE,
  description:
    "Consulta registros de una entidad (filtros, orden, columnas y búsqueda) con los campos que el rol puede ver; devuelve como máximo 50 filas y el total. Un campo oculto o enmascarado no se puede filtrar ni ordenar",
  input,
  output: z.object({
    entity: z.string(),
    rows: z.array(z.record(z.string(), z.unknown())).max(DATA_QUERY_MAX_ROWS),
    total: z.number(),
    page: z.number(),
    truncated: z.boolean(),
  }),
  handler: async (ctx, query) => {
    const entity = gridEntity(ctx.registry, query.entity);
    if (!entity) throw new ProcessError("invalid_input", `unknown entity ${query.entity}`, { details: { reason: "unknown_entity", entity: query.entity } });
    await requireGridAccess(ctx.tx, ctx.registry, entity);
    const state = GridState.parse({ filters: query.filters, sort: query.sort, page: query.page, pageSize: query.limit, columns: query.columns, search: query.search });
    try {
      const { rows, total } = await gridQueryInTx(ctx.tx, entity, state);
      return { entity: entity.id, rows, total, page: query.page, truncated: total > (query.page - 1) * query.limit + rows.length };
    } catch (error) {
      // As the grid answers: a hidden or masked field is a denial, the rest a bad request.
      if (error instanceof QueryError) {
        throw new ProcessError(error.code === "field_hidden" ? "forbidden" : "invalid_input", error.message, { details: { reason: error.code, field: error.field } });
      }
      throw error;
    }
  },
});

export const DATA_PROCESSES = [dataQuery];
