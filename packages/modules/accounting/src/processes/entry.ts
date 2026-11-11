import { defineProcess, ProcessError, visibleExtra, writeSnapshot, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { invalid, settingsOf } from "./common";
import { accountOf, assertValid, loadAccounts, validateLines, type EntryOrigin, type LineInput } from "./entry-validate";
import { assertTemplateValues } from "./template-values";
import { extraForCreate, extraForUpdate } from "./extra";
import { extra, extraFree, extraPatch, id, idOutput, rowOutput } from "./schemas";

// Comprobantes before posting (accounting design §4.6, §4.7, §5.5, §6): create, update and consult. A comprobante is a documento
// that posts itself (entity types spec 2026-11-02 §5, D8; Phase 2A.5 Task 8b): the create processes make a Borrador, Grabar
// (`accounting.entry.save`, entry-lifecycle.ts) posts it, or sends it through approval when it requires approval.

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
/** The states whose header and lines entry.update replaces (D3). */
const EDITABLE = new Set(["draft", "saved", "rejected"]);
const amount = z.number().min(0).max(9_999_999_999_999);
const optionalId = z.uuid().nullish();

/** A line of a comprobante as the UI, the assistant and the importers send it (company currency). */
export const lineInput = z
  .object({
    accountId: z.uuid().optional(),
    accountCode: z.string().trim().regex(/^\d+$/, "El código de la cuenta solo lleva dígitos").optional(),
    partyId: optionalId,
    costCenterId: optionalId,
    openAuxiliaryId: optionalId,
    itemId: optionalId,
    businessUnitId: optionalId,
    description: z.string().trim().max(500).nullish(),
    debit: amount.default(0),
    credit: amount.default(0),
    taxCode: z.string().trim().max(60).nullish(),
    taxRate: z.number().min(0).max(100).nullish(),
    taxBase: amount.nullish(),
    reference: z.string().trim().max(120).nullish(),
    dueDate: z.iso.date().nullish(),
  })
  .strict()
  .refine((line) => !!line.accountId || !!line.accountCode, { message: "Cada línea indica su cuenta (accountId o accountCode)" })
  .refine((line) => (line.debit > 0) !== (line.credit > 0), { message: "Cada línea lleva un valor en débito o en crédito, no en ambos ni en ninguno" });

export const entryHeaderShape = {
  journalId: z.uuid().optional(),
  date: z.iso.date(),
  description: z.string().trim().min(1).max(500),
  currency: z.string().trim().length(3).default("COP"),
  exchangeRate: z.number().positive().default(1),
  businessUnitId: optionalId,
  reverseOn: z.iso.date().nullish(),
  partyId: optionalId,
  lines: z.array(lineInput).max(500),
  extra,
  extraFree: extraFree.optional(),
};

export const entryInput = z.object(entryHeaderShape).strict();
export type EntryInput = z.infer<typeof entryInput>;

/** The journal an entry without one goes to: the settings' manual journal. */
export async function defaultJournal(ctx: ProcessContext, given: string | undefined): Promise<string> {
  if (given) return given;
  const settings = await settingsOf(ctx);
  if (!settings?.manualJournalId) {
    throw new ProcessError("invalid_input", "no_journal: the manual journal is not configured", { details: ["Configura la contabilidad (siembra el plan de cuentas) antes de crear comprobantes"] });
  }
  return settings.manualJournalId;
}

/** Lines with the header's party inherited by those on an account that requires one (EntryInput.partyId). */
export async function inheritParty(ctx: ProcessContext, partyId: string | null | undefined, lines: readonly LineInput[]): Promise<LineInput[]> {
  if (!partyId) return [...lines];
  const accounts = await loadAccounts(ctx, lines);
  return lines.map((line) => (line.partyId || !accountOf(accounts, line)?.requiresParty ? line : { ...line, partyId }));
}

/** `reverse_on` is the day the accrual reverses: after the entry's own date. */
export function assertReverseOn(date: string, reverseOn: string | null | undefined): void {
  if (reverseOn && reverseOn <= date) throw invalid("reverse_on must be after the date", "La fecha de reversión automática debe ser posterior a la fecha del comprobante");
}

/** Inserts the lines of a draft: account codes resolved, document-currency amounts derived from the rate. */
export async function insertLines(ctx: ProcessContext, entryId: string, rate: number, lines: readonly LineInput[]): Promise<void> {
  if (lines.length === 0) return;
  const accounts = await loadAccounts(ctx, lines);
  const rows = lines.map((line, index) => ({
    company_id: ctx.companyId,
    entry_id: entryId,
    line_no: index + 1,
    account_id: accountOf(accounts, line)!.id,
    party_id: line.partyId ?? null,
    cost_center_id: line.costCenterId ?? null,
    open_auxiliary_id: line.openAuxiliaryId ?? null,
    item_id: line.itemId ?? null,
    business_unit_id: line.businessUnitId ?? null,
    description: line.description ?? null,
    debit: round4(line.debit),
    credit: round4(line.credit),
    debit_doc: round4(line.debitDoc ?? line.debit / rate),
    credit_doc: round4(line.creditDoc ?? line.credit / rate),
    tax_code: line.taxCode ?? null,
    tax_rate: line.taxRate ?? null,
    tax_base: line.taxBase ?? null,
    reference: line.reference ?? null,
    due_date: line.dueDate ?? null,
  }));
  await ctx.tx`insert into accounting.entry_lines ${ctx.tx(rows)}`;
}

/**
 * Requiere aprobación of a new comprobante, written by the create process (not left to the column trigger): a person's comprobante
 * (any origin but `auto`) requires approval when the accounting setting require_approval_on_manual is on (§5.12) or the company
 * requires approval of comprobantes in Parámetros (kernel.entity_type_settings); an automatic one never does (its control is the rule).
 */
export async function entryRequiresApproval(ctx: ProcessContext, origin: EntryOrigin): Promise<boolean> {
  if (origin === "auto") return false;
  if ((await settingsOf(ctx))?.requireApprovalOnManual) return true;
  const [row] = await ctx.tx<{ requires_approval: boolean }[]>`
    select requires_approval from kernel.entity_type_settings where company_id = ${ctx.companyId} and entity = 'accounting.entry'`;
  return row?.requires_approval === true;
}

/** Validates in draft mode and inserts a draft with its lines; the shared path of `entry.create`, `entry.from_template` and the opening balances. */
export async function createDraft(ctx: ProcessContext, input: EntryInput, origin: EntryOrigin, extraColumns: Record<string, unknown> = {}): Promise<string> {
  assertReverseOn(input.date, input.reverseOn);
  const journalId = await defaultJournal(ctx, input.journalId);
  const lines = await inheritParty(ctx, input.partyId, input.lines);
  assertValid(await validateLines(ctx, { journalId, date: input.date, businessUnitId: input.businessUnitId, origin }, lines, "draft"));
  const [entry] = await ctx.tx<{ id: string }[]>`
    insert into accounting.entries ${ctx.tx({
      company_id: ctx.companyId, journal_id: journalId, date: input.date, description: input.description, currency: input.currency,
      exchange_rate: input.exchangeRate, business_unit_id: input.businessUnitId ?? null, reverse_on: input.reverseOn ?? null,
      origin, status: "draft", posts: true, requires_approval: await entryRequiresApproval(ctx, origin), ...extraColumns,
    })}
    returning id`;
  await insertLines(ctx, entry!.id, input.exchangeRate, lines);
  return entry!.id;
}

export const entryCreate = defineProcess({
  id: "accounting.entry.create",
  module: "accounting",
  kind: "create",
  feature: "accounting.ledger",
  // A comprobante made from a plantilla (the form of "Nuevo desde plantilla") names it: it needs the plantilla's use right (§9.1).
  recordAccess: { entity: "accounting.entry_template", idField: "templateId", right: "use" },
  description: "Crea un comprobante manual en borrador con sus líneas; el consecutivo se asigna al contabilizar. Con templateId, parte de una plantilla de comprobante",
  input: z.object({ ...entryHeaderShape, templateId: z.uuid().optional() }).strict(),
  output: idOutput,
  handler: async (ctx, { templateId, ...input }) => {
    const custom = await extraForCreate(ctx, "accounting.entry", "accounting.entry.create", input);
    const columns = Object.fromEntries(Object.entries(custom).filter(([, value]) => value !== undefined));
    // A comprobante that arrives from outside the app's forms (the Excel import runs as `api`) is "Importado".
    if (!templateId) return { id: await createDraft(ctx, input, ctx.origin === "api" ? "import" : "manual", columns) };
    const [usable] = await ctx.tx<{ ok: boolean }[]>`select kernel.record_usable('accounting.entry_template', ${templateId}::uuid) as ok`;
    if (!usable?.ok) throw invalid(`template ${templateId} is not usable`, "La plantilla está inactiva o pendiente de aprobación");
    await assertTemplateValues(ctx, templateId, input.lines);
    return { id: await createDraft(ctx, input, "template", { ...columns, template_id: templateId }) };
  },
});

export const entryUpdate = defineProcess({
  id: "accounting.entry.update",
  module: "accounting",
  kind: "update",
  feature: "accounting.ledger",
  description:
    "Reemplaza el encabezado y las líneas de un comprobante en Borrador, Grabado o No Aprobado; no cambia su estado (Grabar lo contabiliza o lo deja listo para aprobación)",
  input: z.object({ id, ...entryHeaderShape, extraPatch }).strict(),
  output: idOutput,
  handler: async (ctx, { id: entryId, extraPatch: patch, ...input }) => {
    const [current] = await ctx.tx<{ status: string; origin: EntryOrigin; journal_id: string; template_id: string | null; extra: Record<string, unknown> }[]>`
      select status, origin, journal_id, template_id, extra from accounting.entries where id = ${entryId} and company_id = ${ctx.companyId} for update`;
    if (!current) throw new ProcessError("not_found", `entry ${entryId} not found`);
    // D3: Borrador, Grabado and No Aprobado take changes; Pendiente, Aprobado, Contabilizado and Anulado do not.
    if (!EDITABLE.has(current.status)) {
      throw new ProcessError("invalid_state", `entry ${entryId}: update is not allowed in status ${current.status}`, {
        details: { from: current.status, action: "save" },
      });
    }
    assertReverseOn(input.date, input.reverseOn);
    const journalId = input.journalId ?? current.journal_id;
    const lines = await inheritParty(ctx, input.partyId, input.lines);
    if (current.template_id) await assertTemplateValues(ctx, current.template_id, lines);
    // A Grabado comprobante is complete (it waits for approval): its edit is checked as for posting.
    const mode = current.status === "saved" ? "post" : "draft";
    assertValid(await validateLines(ctx, { journalId, date: input.date, businessUnitId: input.businessUnitId, origin: current.origin }, lines, mode));
    const custom = await extraForUpdate(ctx, "accounting.entry", "accounting.entry.update", current.extra, { ...input, extraPatch: patch });
    await ctx.tx`
      update accounting.entries set ${ctx.tx({
        journal_id: journalId, date: input.date, description: input.description,
        currency: input.currency, exchange_rate: input.exchangeRate, business_unit_id: input.businessUnitId ?? null, reverse_on: input.reverseOn ?? null,
        ...Object.fromEntries(Object.entries(custom).filter(([, value]) => value !== undefined)),
      })} where id = ${entryId}`;
    await ctx.tx`delete from accounting.entry_lines where entry_id = ${entryId}`;
    await insertLines(ctx, entryId, input.exchangeRate, lines);
    // §8: every data change of a documento past Borrador is snapshotted (one per edit), in its unchanged state.
    if (current.status !== "draft") await writeSnapshot(ctx, ctx.registry.entity("accounting.entry"), entryId, current.status as "saved" | "rejected", null);
    return { id: entryId };
  },
});

type LineRow = Record<string, unknown> & { line_no: number };

/** The lines of an entry through the masked view (a restricted line has its figures and links null and `is_restricted` true), with the account code and name the caller may see. */
export async function entryLinesOf(ctx: ProcessContext, entryId: string): Promise<LineRow[]> {
  return ctx.tx<LineRow[]>`
    select l.*, a.code as account_code, a.name as account_name
    from accounting.v_entry_lines l
    left join accounting.v_accounts a on a.id = l.account_id
    where l.entry_id = ${entryId}
    order by l.line_no`;
}

export const entryConsult = defineProcess({
  id: "accounting.entry.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Consulta un comprobante con sus líneas; las líneas de una cuenta restringida salen enmascaradas y los totales completos",
  input: z.object({ id }),
  output: rowOutput,
  handler: async (ctx, { id: entryId }) => {
    const [row] = await ctx.tx`select * from accounting.v_entries where id = ${entryId}`;
    if (!row) throw new ProcessError("not_found", `entry ${entryId} not found`);
    // Who created it: the approval screen needs it to tell the creator's button apart (four-eyes, §5.5). Not a field of the entity.
    const [owner] = await ctx.tx<{ created_by: string | null }[]>`select created_by from accounting.entries where id = ${entryId}`;
    return { ...row, id: entryId, created_by: owner?.created_by ?? null, extra: await visibleExtra(ctx, "accounting.entry", row.extra), lines: await entryLinesOf(ctx, entryId) };
  },
});

export const entryLineConsult = defineProcess({
  id: "accounting.entry_line.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Consulta las líneas de un comprobante, o una línea por su id; la cuenta restringida sale enmascarada",
  input: z.object({ entryId: id.optional(), id: id.optional() }).strict().refine((v) => !!v.entryId !== !!v.id, { message: "Indica entryId o id" }),
  output: z.looseObject({ lines: z.array(z.looseObject({})) }),
  handler: async (ctx, input) => {
    const lines = input.entryId
      ? await entryLinesOf(ctx, input.entryId)
      : await ctx.tx<LineRow[]>`
          select l.*, a.code as account_code, a.name as account_name
          from accounting.v_entry_lines l left join accounting.v_accounts a on a.id = l.account_id
          where l.id = ${input.id!}`;
    if (!input.entryId && lines.length === 0) throw new ProcessError("not_found", `line ${input.id} not found`);
    return { lines };
  },
});

export const ENTRY_PROCESSES = [entryCreate, entryUpdate, entryConsult, entryLineConsult];
