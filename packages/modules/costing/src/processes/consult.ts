import { defineProcess, ProcessError } from "@erp/kernel";
import { z } from "zod";

// Consult processes of the costing entities: each reads its masked view (rule 14), so a role that may not see a cost gets it masked.

const FEATURE = "costing.costs";
const idInput = z.object({ id: z.uuid() });

function consult(entity: string, view: string, description: string) {
  return defineProcess({
    id: `costing.${entity}.consult`,
    module: "costing",
    kind: "consult",
    feature: FEATURE,
    description,
    input: idInput,
    output: z.looseObject({ id: z.string() }),
    handler: async (ctx, { id }) => {
      const [row] = await ctx.tx`select * from ${ctx.tx("costing")}.${ctx.tx(view)} where id = ${id}`;
      if (!row) throw new ProcessError("not_found", `costing.${entity} ${id} not found`);
      return { ...row, id };
    },
  });
}

export const costLayerConsult = consult("cost_layer", "v_cost_layers", "Consulta la capa de costo promedio de un producto en una bodega (cantidad, valor y costo promedio) con los campos que el rol puede ver");
export const costEventConsult = consult("cost_event", "v_cost_events", "Consulta la valoración de una línea de movimiento de inventario (costo unitario, valor y origen del costo) con los campos que el rol puede ver");
export const costMissingConsult = consult("cost_missing", "v_cost_missing", "Consulta un producto sin costo en una bodega: cuántas veces se movió valorizado en cero y desde cuándo");

export const CONSULT_PROCESSES = [costLayerConsult, costEventConsult, costMissingConsult];
