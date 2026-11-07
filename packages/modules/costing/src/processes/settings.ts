import { defineProcess } from "@erp/kernel";
import { z } from "zod";
import { COST_METHODS, UNKNOWN_COST_MODES, type UnknownCostMode } from "../entities";
import { refuse } from "./common";

// Parámetros de costos (plan 2B Task 9, OD-5): the costing method of the company. Weighted average is the only method accepted in 2B;
// FIFO is phase 3. The table's check and the cost layers already carry what FIFO needs (a `method` and the layer-per-receipt columns), so
// phase 3 widens the check and this list, with no data migration. A company without a row costs by `average`.

const FEATURE = "costing.settings";

/** The refusal of FIFO, Spanish copy as the catalogue has it (`costing.errors.fifo_phase_3`; the i18n catalogue test keeps both equal). */
export const FIFO_PHASE_3 = "El método PEPS (FIFO) está disponible en la fase 3; por ahora el costo se calcula por promedio ponderado";

export const settingsUpdate = defineProcess({
  id: "costing.settings.update",
  module: "costing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  sensitivity: "step-up",
  description: "Cambia el método de costeo de la empresa; por ahora solo se acepta el promedio ponderado (FIFO llega en la fase 3)",
  input: z.object({ method: z.enum(["average", "fifo"]) }).strict(),
  output: z.object({ id: z.string(), method: z.enum(COST_METHODS) }),
  handler: async (ctx, { method }) => {
    if (method !== "average") refuse("method_not_available", [FIFO_PHASE_3]);
    const [current] = await ctx.tx<{ id: string }[]>`select id from costing.settings where company_id = ${ctx.companyId} for update`;
    if (current) {
      await ctx.tx`update costing.settings set method = ${method} where id = ${current.id}`;
      return { id: current.id, method };
    }
    const [row] = await ctx.tx<{ id: string }[]>`insert into costing.settings ${ctx.tx({ company_id: ctx.companyId, method })} returning id`;
    return { id: row!.id, method };
  },
});

// Plan 2B.2 Task 44 (owner item 36, R44-2): what a unit without a known cost is valued at, `zero` (default) or `last_known`. The only way to
// change the mode: the trigger of migration 0130 refuses any other user session. It is one column of the settings row, upserted like the
// method (no row: insert with the default method); settings.update never touches it and this never touches the method. The change applies
// from the next movement costed and rewrites nothing; the row audit keeps unknown_cost_mode's before and after.
export const unknownCostSet = defineProcess({
  id: "costing.unknown_cost.set",
  module: "costing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  sensitivity: "step-up",
  description:
    "Cambia el costo con el que se valoran las unidades sin costo conocido: cero (como hasta ahora) o el último costo conocido del producto (una estimación); vale desde el siguiente movimiento y no recalcula nada",
  input: z.object({ mode: z.enum(UNKNOWN_COST_MODES) }).strict(),
  output: z.object({ id: z.string(), mode: z.enum(UNKNOWN_COST_MODES), previous: z.enum(UNKNOWN_COST_MODES) }),
  handler: async (ctx, { mode }) => {
    // The row's lock: two switches at once apply one after the other, each answering the mode it replaced.
    const [current] = await ctx.tx<{ id: string; unknown_cost_mode: UnknownCostMode }[]>`
      select id, unknown_cost_mode from costing.settings where company_id = ${ctx.companyId} for update`;
    if (current) {
      if (current.unknown_cost_mode !== mode) await ctx.tx`update costing.settings set unknown_cost_mode = ${mode} where id = ${current.id}`;
      return { id: current.id, mode, previous: current.unknown_cost_mode };
    }
    const [row] = await ctx.tx<{ id: string }[]>`insert into costing.settings ${ctx.tx({ company_id: ctx.companyId, unknown_cost_mode: mode })} returning id`;
    return { id: row!.id, mode, previous: "zero" as const };
  },
});

export const settingsConsult = defineProcess({
  id: "costing.settings.consult",
  module: "costing",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta el método de costeo de la empresa (promedio ponderado mientras no se haya configurado) y el costo de las unidades sin costo conocido (cero mientras no se haya configurado)",
  input: z.object({}),
  output: z.looseObject({ configured: z.boolean(), method: z.enum(COST_METHODS), unknownCostMode: z.enum(UNKNOWN_COST_MODES) }),
  handler: async (ctx) => {
    const [row] = await ctx.tx`select * from costing.v_settings where company_id = ${ctx.companyId}`;
    return row
      ? {
          ...row, configured: true, method: (row.method ?? "average") as (typeof COST_METHODS)[number],
          // A masked mode (null) reads as the default; the valuation itself reads the table, never this view (R44-9).
          unknownCostMode: (row.unknown_cost_mode ?? "zero") as UnknownCostMode,
        }
      : { configured: false, method: "average" as const, unknownCostMode: "zero" as const };
  },
});

export const SETTINGS_PROCESSES = [settingsUpdate, unknownCostSet, settingsConsult];
