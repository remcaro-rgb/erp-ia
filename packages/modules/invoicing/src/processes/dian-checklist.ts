import { defineProcess, ProcessError, type DianChecklist, type DianChecklistItem, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { FEATURE_SETTINGS, packOf, refuseState, requireCompanyAdmin, settingsOf } from "./common";
import { ADMIN_ONLY } from "./parametros";

// The DIAN verification checklist (plan 2B Task 35, owner item 20; R35-1..R35-15). The country pack lists the values the documents carry that
// the DIAN may still ask to change (`packOf(ctx).einvoice.dianChecklist`, fiscal content: rule 5); the company's admin ticks each one once
// verified in the DIAN's habilitación, and only with every item ticked can they confirm the defaults, which is what the production guard of
// Task 19 reads. Three processes, all the company admin's (rule 13) and in the settings feature:
//   - invoicing.dian_checklist.tick (STEP-UP): ticks and unticks, one run, one code, one transaction. Every changed row writes its own row
//     audit entry (who, when, before and after: rule 16); a repeat changes nothing. Unticking while the confirmation stands clears it in the
//     same transaction; in producción nothing can be unticked (the confirmation cannot be withdrawn there: migration 0101).
//   - invoicing.dian_defaults.confirm (STEP-UP): sets (every item ticked) or clears the confirmation, stamping the list version.
//   - invoicing.dian_checklist.consult: the list with who ticked each item and when, the progress and whether the confirmation is effective.
// Neither mutating process is an assistant tool (packages/agent: EXCLUDED_PROCESSES), and the database refuses a user session that changes the
// flag or the ticks outside them (migration 0135), so the confirmation is a human's, behind a fresh code.
//
// EFFECTIVE CONFIRMATION (R35-7): the stored flag AND the stored version equal to the pack's current version AND every item of the current
// list ticked. Adding an item to the list therefore ends the confirmation at once, everywhere, with no write: the stored flag may still read
// true until the next tick or confirm run touches it, and that run lowers it (audited).

export const TICK_PROCESS = "invoicing.dian_checklist.tick";
export const CONFIRM_PROCESS = "invoicing.dian_defaults.confirm";

/** What the rule needs of the checklist and the company's confirmation (read from the tables: a rule never reads a masked view). */
export interface ConfirmationState {
  list: DianChecklist;
  stored: boolean;
  storedVersion: number | null;
  environment: string;
  /** The items of the current list not ticked, in display order. */
  pending: DianChecklistItem[];
  /** The stored flag, at the current version, with every item ticked. */
  effective: boolean;
}

/**
 * The confirmation as it counts. `overrides` are the settings a save is about to write (Task 28.4 review): a conditional row is judged on
 * them, not on the stored ones, so a save that turns dian_item_instance on is judged with lotes_en_xml in the list.
 */
export async function effectiveConfirmation(ctx: ProcessContext, overrides: { dianItemInstance?: boolean } = {}): Promise<ConfirmationState> {
  const { einvoice } = await packOf(ctx);
  // A conditional row applies only while its setting is on (Task 28.4: lotes_en_xml with dian_item_instance).
  const dianItemInstance = overrides.dianItemInstance ?? (await settingsOf(ctx)).dianItemInstance;
  const on = { dian_item_instance: dianItemInstance };
  const list = { ...einvoice.dianChecklist, items: einvoice.dianChecklist.items.filter((item) => !item.when || on[item.when]) };
  const [row] = await ctx.tx<{ confirmed: boolean; version: number | null; environment: string }[]>`
    select dian_defaults_confirmed as confirmed, dian_checklist_version as version, dian_environment as environment
    from invoicing.settings where company_id = ${ctx.companyId}`;
  const ticked = new Set((await ctx.tx<{ item_key: string }[]>`select item_key from invoicing.dian_checks where company_id = ${ctx.companyId} and ticked`).map((r) => r.item_key));
  const pending = list.items.filter((item) => !ticked.has(item.key));
  const stored = row?.confirmed ?? false;
  const storedVersion = row?.version ?? null;
  return { list, stored, storedVersion, environment: row?.environment ?? "habilitacion", pending, effective: stored && storedVersion === list.version && pending.length === 0 };
}

/** Why a confirmation is not effective, as the production guard words it (the number of items left, or that it must be made again). */
export function pendingMessage(state: Pick<ConfirmationState, "pending">): string {
  const n = state.pending.length;
  if (n === 0) return "Confirma de nuevo los valores por defecto en la lista de verificación DIAN antes de pasar a producción";
  return n === 1
    ? "Verifica el valor pendiente en la lista de verificación DIAN antes de pasar a producción"
    : `Verifica los ${n} valores pendientes en la lista de verificación DIAN antes de pasar a producción`;
}

/**
 * Serialises the two mutating processes on the company's settings row (the row is made first when missing): a confirm that read every item
 * ticked cannot commit beside an untick that read no confirmation, so an untick always meets the confirmation it must clear.
 */
async function lockSettings(ctx: ProcessContext): Promise<void> {
  await ctx.tx`insert into invoicing.settings ${ctx.tx({ company_id: ctx.companyId } as never)} on conflict (company_id) do nothing`;
  await ctx.tx`select 1 from invoicing.settings where company_id = ${ctx.companyId} for update`;
}

interface CheckRow { item_key: string; ticked: boolean | null; ticked_by: string | null; ticked_at: Date | null }

/** The ticks through the masked view (rule 14): a hidden column reads null. */
async function checksOf(ctx: ProcessContext, keys?: readonly string[]): Promise<Map<string, CheckRow>> {
  const rows = keys
    ? await ctx.tx<CheckRow[]>`select item_key, ticked, ticked_by, ticked_at from invoicing.v_dian_checks where company_id = ${ctx.companyId} and item_key = any(${keys as string[]})`
    : await ctx.tx<CheckRow[]>`select item_key, ticked, ticked_by, ticked_at from invoicing.v_dian_checks where company_id = ${ctx.companyId}`;
  return new Map(rows.map((r) => [r.item_key, r]));
}

/** Display names of the users (the audit viewer reads the same users view: rule 14), the e-mail when a user has no name. */
async function namesOf(ctx: ProcessContext, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (unique.length === 0) return new Map();
  const users = await ctx.tx<{ id: string; name: string | null }[]>`select id, coalesce(nullif(trim(full_name), ''), email) as name from kernel.v_users where id = any(${unique}::uuid[])`;
  return new Map(users.flatMap((u) => (u.name ? [[u.id, u.name] as const] : [])));
}

const iso = (value: Date | string | null | undefined): string | null => (value == null ? null : (value instanceof Date ? value : new Date(value)).toISOString());

const itemOutput = z.object({ itemKey: z.string(), ticked: z.boolean(), tickedBy: z.string().nullable(), tickedAt: z.string().nullable() });
const progressOutput = z.object({ done: z.number(), total: z.number() });

/** Where the run stands after it wrote: the ticks of the current list, through the view. */
async function progressOf(ctx: ProcessContext, list: DianChecklist): Promise<{ done: number; total: number }> {
  const checks = await checksOf(ctx);
  return { done: list.items.filter((item) => checks.get(item.key)?.ticked === true).length, total: list.items.length };
}

export const dianChecklistTick = defineProcess({
  id: TICK_PROCESS,
  module: "invoicing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE_SETTINGS,
  sensitivity: "step-up",
  description:
    "Marca o desmarca valores de la lista de verificación DIAN: lo que el administrador verificó en la habilitación de la DIAN (tipos de nota, firma, respuesta, impuestos, medios de pago…). Quien marca y cuándo quedan registrados; desmarcar cualquiera deja sin efecto la confirmación de los valores por defecto",
  input: z.object({
    items: z.array(z.object({ itemKey: z.string().trim().min(1).max(80), ticked: z.boolean() }).strict()).min(1).max(50)
      .refine((items) => new Set(items.map((i) => i.itemKey)).size === items.length, "Un valor no puede venir dos veces en la misma ejecución"),
  }).strict(),
  output: z.object({ items: z.array(itemOutput), progress: progressOutput, confirmationCleared: z.boolean() }),
  handler: async (ctx, input) => {
    await requireCompanyAdmin(ctx, ADMIN_ONLY);
    await lockSettings(ctx);
    const state = await effectiveConfirmation(ctx);
    // Any row of the pack's list, a conditional one included (Task 28.4: lotes_en_xml may be verified before the setting is turned on).
    const known = new Set((await packOf(ctx)).einvoice.dianChecklist.items.map((i) => i.key));
    const unknown = input.items.filter((i) => !known.has(i.itemKey)).map((i) => i.itemKey);
    if (unknown.length > 0) throw new ProcessError("invalid_input", `Valores que no están en la lista de verificación DIAN: ${unknown.join(", ")}`, { details: unknown });
    // What the run would change, from the rows as they are (the table: the ticked flag is never hidden from a rule).
    const rows = await ctx.tx<{ id: string; item_key: string; ticked: boolean }[]>`
      select id, item_key, ticked from invoicing.dian_checks where company_id = ${ctx.companyId} and item_key = any(${input.items.map((i) => i.itemKey)}) for update`;
    const byKey = new Map(rows.map((r) => [r.item_key, r]));
    const changes = input.items.filter((i) => (byKey.get(i.itemKey)?.ticked ?? false) !== i.ticked);
    const unticks = changes.filter((i) => !i.ticked);
    if (unticks.length > 0 && state.environment === "produccion") {
      refuseState("dian_in_production", ["La empresa está en producción: la confirmación de los valores por defecto no se retira. Vuelve a habilitación en los parámetros de facturación para desmarcar valores"]);
    }
    for (const change of changes) {
      const row = byKey.get(change.itemKey);
      if (!change.ticked) {
        await ctx.tx`update invoicing.dian_checks set ticked = false, ticked_by = null, ticked_at = null where id = ${row!.id}`;
      } else if (row) {
        await ctx.tx`update invoicing.dian_checks set ticked = true, ticked_by = ${ctx.userId}, ticked_at = now() where id = ${row.id}`;
      } else {
        await ctx.tx`insert into invoicing.dian_checks (company_id, item_key, ticked, ticked_by, ticked_at) values (${ctx.companyId}, ${change.itemKey}, true, ${ctx.userId}, now())`;
      }
    }
    // Unticking ends the confirmation in the same transaction (and the stored list version with it). So does any run that finds a stored
    // confirmation made at an older list version (R35-7: the stored flag lags a version bump until a run touches it, and that run lowers it,
    // audited); in producción the stored flag stays (0101).
    let confirmationCleared = false;
    const stale = state.stored && state.storedVersion !== state.list.version && state.environment !== "produccion";
    if ((unticks.length > 0 && (state.stored || state.storedVersion !== null)) || stale) {
      await ctx.tx`update invoicing.settings set dian_defaults_confirmed = false, dian_checklist_version = null where company_id = ${ctx.companyId}`;
      confirmationCleared = true;
    }
    const checks = await checksOf(ctx, input.items.map((i) => i.itemKey));
    const names = await namesOf(ctx, [...checks.values()].map((c) => c.ticked_by));
    return {
      items: input.items.map((i) => {
        const c = checks.get(i.itemKey);
        return { itemKey: i.itemKey, ticked: c?.ticked === true, tickedBy: c?.ticked_by ? (names.get(c.ticked_by) ?? null) : null, tickedAt: iso(c?.ticked_at) };
      }),
      progress: await progressOf(ctx, state.list),
      confirmationCleared,
    };
  },
});

export const dianDefaultsConfirm = defineProcess({
  id: CONFIRM_PROCESS,
  module: "invoicing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE_SETTINGS,
  sensitivity: "step-up",
  description:
    "Confirma los valores por defecto del documento electrónico, que la empresa necesita para pasar a producción: solo con todos los valores de la lista de verificación DIAN marcados. También retira la confirmación (no en producción)",
  input: z.object({ confirmed: z.boolean() }).strict(),
  output: z.object({ confirmed: z.boolean(), version: z.number().nullable() }),
  handler: async (ctx, input) => {
    await requireCompanyAdmin(ctx, ADMIN_ONLY);
    await lockSettings(ctx);
    const state = await effectiveConfirmation(ctx);
    if (input.confirmed) {
      if (state.pending.length > 0) {
        const n = state.pending.length;
        refuseState("dian_checklist_incomplete", [
          n === 1 ? "Falta verificar 1 valor de la lista de verificación DIAN antes de confirmar los valores por defecto" : `Faltan por verificar ${n} valores de la lista de verificación DIAN antes de confirmar los valores por defecto`,
          ...state.pending.map((item) => item.es),
        ]);
      }
      // An upsert's CHECK would judge the row it proposes (no flag yet); the row is made first, then confirmed.
      await ctx.tx`insert into invoicing.settings ${ctx.tx({ company_id: ctx.companyId } as never)} on conflict (company_id) do nothing`;
      await ctx.tx`update invoicing.settings set dian_defaults_confirmed = true, dian_checklist_version = ${state.list.version} where company_id = ${ctx.companyId}`;
      return { confirmed: true, version: state.list.version };
    }
    // The confirmation cannot be withdrawn in producción (the database holds the rule too: 0101).
    if (state.environment === "produccion") {
      refuseState("dian_defaults_unconfirmed", ["La empresa está en producción: la confirmación de los valores por defecto no se retira. Vuelve a habilitación para cambiarla"]);
    }
    await ctx.tx`update invoicing.settings set dian_defaults_confirmed = false, dian_checklist_version = null where company_id = ${ctx.companyId}`;
    return { confirmed: false, version: null };
  },
});

export const dianChecklistConsult = defineProcess({
  id: "invoicing.dian_checklist.consult",
  module: "invoicing",
  kind: "consult",
  feature: FEATURE_SETTINGS,
  description: "Consulta la lista de verificación DIAN: cada valor con quién lo verificó y cuándo, el avance y si la confirmación de los valores por defecto está vigente",
  input: z.object({}),
  output: z.object({
    version: z.number(),
    storedVersion: z.number().nullable(),
    confirmed: z.boolean(),
    confirmedAt: z.string().nullable(),
    confirmedBy: z.string().nullable(),
    environment: z.string(),
    progress: progressOutput,
    items: z.array(z.object({
      key: z.string(), group: z.string(), es: z.string(), en: z.string(), docUrl: z.string().nullable(),
      ticked: z.boolean(), tickedBy: z.string().nullable(), tickedAt: z.string().nullable(), isNew: z.boolean(),
    })),
  }),
  handler: async (ctx) => {
    await requireCompanyAdmin(ctx, ADMIN_ONLY);
    const state = await effectiveConfirmation(ctx);
    const checks = await checksOf(ctx);
    // The settings' own columns through their masked view: a hidden stored version reads as none.
    const [shown] = await ctx.tx<{ version: number | null }[]>`select dian_checklist_version as version from invoicing.v_settings where company_id = ${ctx.companyId}`;
    // When and by whom the confirmation was made: the last confirm run that stamped a version (the audit viewer's own read, the admin's).
    const [confirmedRun] = state.effective
      ? await ctx.tx<{ at: Date; actor: string | null }[]>`
          select occurred_at as at, actor_user_id as actor from kernel.v_audit_entries
          where company_id = ${ctx.companyId} and entity = 'invoicing.settings' and process_id = ${CONFIRM_PROCESS} and coalesce(diff->'dian_checklist_version'->>'new', '') <> ''
          order by occurred_at desc, id desc limit 1`
      : [];
    const names = await namesOf(ctx, [...[...checks.values()].map((c) => c.ticked_by), confirmedRun?.actor ?? null]);
    const storedVersion = shown?.version ?? null;
    const items = state.list.items.map((item) => {
      const c = checks.get(item.key);
      return {
        key: item.key, group: item.group, es: item.es, en: item.en, docUrl: item.docUrl ?? null,
        ticked: c?.ticked === true, tickedBy: c?.ticked_by ? (names.get(c.ticked_by) ?? null) : null, tickedAt: iso(c?.ticked_at),
        // New since the confirmation was made (R35-10): only when a confirmation exists to compare with.
        isNew: state.storedVersion !== null && item.since > state.storedVersion,
      };
    });
    return {
      version: state.list.version,
      storedVersion,
      confirmed: state.effective,
      confirmedAt: iso(confirmedRun?.at),
      confirmedBy: confirmedRun?.actor ? (names.get(confirmedRun.actor) ?? null) : null,
      environment: state.environment,
      progress: { done: items.filter((i) => i.ticked).length, total: items.length },
      items,
    };
  },
});

export const DIAN_CHECKLIST_PROCESSES = [dianChecklistTick, dianDefaultsConfirm, dianChecklistConsult];
