import { defineProcess, GridState, gridQueryInTx, ProcessError, QueryError } from "@erp/kernel";
import { z } from "zod";

// «Por facturar» (plan 2B Task 20 fix round 1, rule 20): the invoicing.pending_line query entity has no table, so its grid opens through
// invoicing.pending_line.list (the entity's consult process, consultProcessesOf), which reads the masked view v_pending_lines through the
// grid layer as the caller: company RLS, the sales and invoicing tables' RLS under the view, field modes. «Crear facturas» is
// invoicing.invoice.from_orders with the pedidos of the lines chosen.

const ENTITY = "invoicing.pending_line";

const groupSchema = z.object({ level: z.number(), keys: z.record(z.string(), z.unknown()), count: z.number(), aggregates: z.record(z.string(), z.unknown()) });

/** The grid layer's refusals as the process answers them: a hidden or masked field is a denial, the rest a bad request. */
function asProcessError(error: unknown): unknown {
  if (error instanceof QueryError) {
    return new ProcessError(error.code === "field_hidden" ? "forbidden" : "invalid_input", error.message, { details: { reason: error.code, field: error.field } });
  }
  return error;
}

export const pendingLineList = defineProcess({
  id: "invoicing.pending_line.list",
  module: "invoicing",
  kind: "consult",
  feature: "invoicing.invoices",
  description: "Consulta lo que las entregas despacharon y ninguna factura cobra aún (Por facturar): filtros, orden, páginas y agregados, sin precios",
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

export const PENDING_PROCESSES = [pendingLineList];
