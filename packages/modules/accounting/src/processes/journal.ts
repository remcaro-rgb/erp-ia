import { defineProcess, ProcessError, visibleExtra, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { entityDef } from "../entities";
import { defined, invalid, refuseDuplicate, settingsOf } from "./common";
import { extraForCreate, extraForUpdate } from "./extra";
import { assertWritable, followLifecycle, initialLifecycle, lifecycleProcesses } from "./lifecycle";
import { extra, extraFree, extraPatch, id, idOutput, name, rowOutput } from "./schemas";

// Fuentes (journals, accounting design §4.3). The consecutivo is the journal's own and advances only at post.

const CODE_KEY = "journals_company_id_code_key";
const kind = z.enum(["general", "sales", "purchases", "receipts", "payments", "opening", "closing"]);
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/, "El código de la fuente lleva de 1 a 6 letras o dígitos");

/** The columns journal.update writes: the code and the consecutivo never change by hand. */
const WRITABLE = new Set(["name", "kind", "manual_entries", "is_active", "extra", "extra_free"]);

/** The manual journal of the settings keeps taking manual entries and stays active (§4.3). */
async function assertNotManualJournal(ctx: ProcessContext, journalId: string): Promise<void> {
  const settings = await settingsOf(ctx);
  if (settings?.manualJournalId === journalId) {
    throw invalid(`journal ${journalId} is the manual journal`, "Es la fuente de los comprobantes manuales: elige otra en la configuración contable antes");
  }
}

/** The journal's lifecycle hook: Grabar writes only the update process's columns and runs its checks (Task 8b). */
export const journalHooks: TypedHooks = {
  async validate(ctx, record, mode, change) {
    if (mode !== "save") return;
    assertWritable("accounting.journal.save", change.data, WRITABLE);
    if (typeof record.name !== "string" || record.name.trim() === "") throw invalid("journal name is empty", "La fuente lleva un nombre");
    if (record.is_active === false || record.manual_entries === false) await assertNotManualJournal(ctx, record.id);
  },
};

export const journalCreate = defineProcess({
  id: "accounting.journal.create",
  module: "accounting",
  kind: "create",
  feature: "accounting.ledger",
  description: "Crea una fuente (tipo de comprobante) con su propio consecutivo",
  input: z.object({ code, name, kind, manualEntries: z.boolean().default(true), isActive: z.boolean().default(true), extra, extraFree: extraFree.optional() }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    const custom = await extraForCreate(ctx, "accounting.journal", "accounting.journal.create", input);
    const lifecycle = await initialLifecycle(ctx, "accounting.journal");
    const [inserted] = await refuseDuplicate("accounting.journal.create", CODE_KEY, `Ya existe la fuente ${input.code}`, () => ctx.tx<{ id: string }[]>`
      insert into accounting.journals ${ctx.tx({
        company_id: ctx.companyId, code: input.code, name: input.name, kind: input.kind,
        manual_entries: input.manualEntries, is_active: input.isActive, ...defined(custom), ...lifecycle,
      })}
      returning id`);
    return { id: inserted!.id };
  },
});

export const journalUpdate = defineProcess({
  id: "accounting.journal.update",
  module: "accounting",
  kind: "update",
  feature: "accounting.ledger",
  description: "Actualiza el nombre, el tipo o el estado de una fuente; el código y el consecutivo no cambian",
  input: z.object({ id, name: name.optional(), kind: kind.optional(), manualEntries: z.boolean().optional(), isActive: z.boolean().optional(), extra, extraPatch, extraFree: extraFree.optional() }).strict(),
  output: idOutput,
  handler: async (ctx, { id: journalId, extraPatch: patch, ...input }) => {
    const [current] = await ctx.tx<{ extra: Record<string, unknown> }[]>`
      select * from accounting.journals where id = ${journalId} and company_id = ${ctx.companyId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `journal ${journalId} not found`);
    if (input.isActive === false || input.manualEntries === false) await assertNotManualJournal(ctx, journalId);
    const custom = await extraForUpdate(ctx, "accounting.journal", "accounting.journal.update", current.extra, { ...input, extraPatch: patch });
    const set = defined({ name: input.name, kind: input.kind, manual_entries: input.manualEntries, is_active: input.isActive, ...custom });
    if (Object.keys(set).length > 0) await ctx.tx`update accounting.journals set ${ctx.tx(set)} where id = ${journalId}`;
    await followLifecycle(ctx, "accounting.journal", journalId, current);
    return { id: journalId };
  },
});

export const journalConsult = defineProcess({
  id: "accounting.journal.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Consulta una fuente con su consecutivo",
  input: z.object({ id }),
  output: rowOutput,
  handler: async (ctx, { id: journalId }) => {
    const [row] = await ctx.tx`select * from accounting.v_journals where id = ${journalId}`;
    if (!row) throw new ProcessError("not_found", `journal ${journalId} not found`);
    return { ...row, id: journalId, extra: await visibleExtra(ctx, "accounting.journal", row.extra) };
  },
});

export const JOURNAL_PROCESSES = [journalCreate, journalUpdate, journalConsult, ...lifecycleProcesses(entityDef("accounting.journal"), "accounting.ledger", { writable: WRITABLE })];
