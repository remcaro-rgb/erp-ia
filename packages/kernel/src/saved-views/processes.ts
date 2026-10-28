import { z } from "zod";
import { registeredEntity } from "../attachments/guards";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { GridState } from "../query/grid-state";

// Saved grid views (design §9, rule 20): a user's named grid state per entity, in the active company, one of them
// the default. Normal permissions (`kernel.saved_view.*`, granted to every role by the company's seed); the table's
// RLS keeps every user to their own rows, so a permission never reaches anyone else's views.

const FEATURE = "kernel.saved_views";

/** What a view keeps of a grid state: everything but the page it was on. */
export const SavedViewState = GridState.omit({ page: true }).partial();
export type SavedViewState = z.infer<typeof SavedViewState>;

const entity = z.string().min(1).max(80);
const name = z.string().trim().min(1).max(80);

export interface SavedView {
  id: string;
  entity: string;
  name: string;
  state: SavedViewState;
  isDefault: boolean;
}

const viewOutput = z.object({ id: z.string(), entity: z.string(), name: z.string(), state: z.record(z.string(), z.unknown()), isDefault: z.boolean() });

export const savedViewSave = defineProcess({
  id: "kernel.saved_view.save",
  module: "kernel",
  kind: "update",
  feature: FEATURE,
  description: "Guarda una vista de un listado (filtros, orden, columnas) con un nombre; puede quedar como la vista por defecto",
  input: z.object({ entity, name, state: SavedViewState, isDefault: z.boolean().default(false) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    registeredEntity(ctx, input.entity);
    if (input.isDefault) {
      await ctx.tx`
        update kernel.saved_views set is_default = false
        where company_id = ${ctx.companyId} and user_id = ${ctx.userId} and entity = ${input.entity} and is_default and name <> ${input.name}`;
    }
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into kernel.saved_views (company_id, user_id, entity, name, state, is_default)
      values (${ctx.companyId}, ${ctx.userId}, ${input.entity}, ${input.name}, ${ctx.tx.json(input.state as never)}, ${input.isDefault})
      on conflict (company_id, user_id, entity, name)
      do update set state = excluded.state, is_default = excluded.is_default, updated_by = ${ctx.userId}
      returning id`;
    return { id: row!.id };
  },
});

export const savedViewList = defineProcess({
  id: "kernel.saved_view.list",
  module: "kernel",
  kind: "consult",
  feature: FEATURE,
  description: "Lista las vistas guardadas del usuario para un listado",
  input: z.object({ entity }),
  output: z.array(viewOutput),
  handler: async (ctx, input) => {
    const rows = await ctx.tx<{ id: string; entity: string; name: string; state: SavedViewState; is_default: boolean }[]>`
      select id, entity, name, state, is_default from kernel.saved_views
      where company_id = ${ctx.companyId} and user_id = ${ctx.userId} and entity = ${input.entity}
      order by is_default desc, name`;
    return rows.map((r) => ({ id: r.id, entity: r.entity, name: r.name, state: r.state, isDefault: r.is_default }));
  },
});

export const savedViewDelete = defineProcess({
  id: "kernel.saved_view.delete",
  module: "kernel",
  kind: "delete",
  feature: FEATURE,
  description: "Borra una vista guardada del usuario",
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const rows = await ctx.tx`delete from kernel.saved_views where id = ${input.id} and user_id = ${ctx.userId} returning id`;
    if (rows.length === 0) throw new ProcessError("not_found", `saved view ${input.id} not found`);
    return { id: input.id };
  },
});

export const SAVED_VIEW_PROCESSES = [savedViewSave, savedViewList, savedViewDelete];
export const SAVED_VIEW_PROCESS_IDS = SAVED_VIEW_PROCESSES.map((p) => p.id);
