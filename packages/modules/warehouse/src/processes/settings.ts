import { defineProcess } from "@erp/kernel";
import { z } from "zod";
import { DEFAULT_SETTINGS, refuse } from "./common";

// Parámetros de bodega (plan 2B.2 Task 29.1, PG §4.2): whether a confirmed pedido makes its alistamiento by itself (auto_pick_on_confirm)
// and whether a confirmed and allocated alistamiento asks sales for a Borrador entrega (delivery_from_pick; sales acts on inventory's answer,
// Task 29.2). One row per company, upserted; none means both on. An admin process: step-up by default (rule 15, PG §4.4).

const FEATURE = "warehouse.settings";

const output = z.object({ id: z.string(), autoPickOnConfirm: z.boolean(), deliveryFromPick: z.boolean() });

export const settingsUpdate = defineProcess({
  id: "warehouse.settings.update",
  module: "warehouse",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE,
  sensitivity: "step-up",
  description:
    "Cambia los parámetros de bodega de la empresa: si un pedido confirmado crea su alistamiento automáticamente y si un alistamiento confirmado crea la entrega en borrador",
  input: z.object({ autoPickOnConfirm: z.boolean().optional(), deliveryFromPick: z.boolean().optional() }).strict(),
  output,
  handler: async (ctx, input) => {
    if (input.autoPickOnConfirm === undefined && input.deliveryFromPick === undefined) refuse("nothing_to_change", ["Indica qué parámetro cambia"]);
    const set = Object.fromEntries(Object.entries({ auto_pick_on_confirm: input.autoPickOnConfirm, delivery_from_pick: input.deliveryFromPick }).filter(([, v]) => v !== undefined));
    // The row's lock: two changes at once apply one after the other.
    const [current] = await ctx.tx<{ id: string }[]>`select id from warehouse.settings where company_id = ${ctx.companyId} for update`;
    const [row] = current
      ? await ctx.tx<{ id: string; auto_pick_on_confirm: boolean; delivery_from_pick: boolean }[]>`
          update warehouse.settings set ${ctx.tx(set)} where id = ${current.id} returning id, auto_pick_on_confirm, delivery_from_pick`
      : await ctx.tx<{ id: string; auto_pick_on_confirm: boolean; delivery_from_pick: boolean }[]>`
          insert into warehouse.settings ${ctx.tx({
            company_id: ctx.companyId,
            auto_pick_on_confirm: input.autoPickOnConfirm ?? DEFAULT_SETTINGS.autoPickOnConfirm,
            delivery_from_pick: input.deliveryFromPick ?? DEFAULT_SETTINGS.deliveryFromPick,
          })} returning id, auto_pick_on_confirm, delivery_from_pick`;
    return { id: row!.id, autoPickOnConfirm: row!.auto_pick_on_confirm, deliveryFromPick: row!.delivery_from_pick };
  },
});

export const settingsConsult = defineProcess({
  id: "warehouse.settings.consult",
  module: "warehouse",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta los parámetros de bodega de la empresa (ambos activos mientras no se hayan configurado)",
  input: z.object({}),
  output: z.looseObject({ configured: z.boolean(), autoPickOnConfirm: z.boolean().nullable(), deliveryFromPick: z.boolean().nullable() }),
  handler: async (ctx) => {
    const [row] = await ctx.tx<Record<string, unknown>[]>`select * from warehouse.v_settings where company_id = ${ctx.companyId}`;
    return row
      ? { ...row, configured: true, autoPickOnConfirm: (row.auto_pick_on_confirm as boolean | null) ?? null, deliveryFromPick: (row.delivery_from_pick as boolean | null) ?? null }
      : { configured: false, autoPickOnConfirm: DEFAULT_SETTINGS.autoPickOnConfirm, deliveryFromPick: DEFAULT_SETTINGS.deliveryFromPick };
  },
});

export const SETTINGS_PROCESSES = [settingsUpdate, settingsConsult];
