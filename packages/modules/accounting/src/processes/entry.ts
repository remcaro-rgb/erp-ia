import { defineProcess, ProcessError, visibleExtra, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { invalid, settingsOf } from "./common";
import { accountOf, assertValid, loadAccounts, validateLines, type EntryOrigin, type LineInput } from "./entry-validate";
import { extraForCreate, extraForUpdate } from "./extra";
import { extra, extraFree, extraPatch, id, idOutput, rowOutput } from "./schemas";

// Comprobantes in draft (accounting design §4.6, §4.7, §5.5, §6): create, update, void and consult. A draft is a person's
// work in progress; `entry.submit` and `entry.post` (Task 19) take it from there.

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
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
    debit_doc: round4(line.debit / rate),
    credit_doc: round4(line.credit / rate),
    tax_code: line.taxCode ?? null,
    tax_rate: line.taxRate ?? null,
    tax_base: line.taxBase ?? null,
    reference: line.reference ?? null,
    due_date: line.dueDate ?? null,
  }));
  await ctx.tx`insert into accounting.entry_lines ${ctx.tx(rows)}`;
}

/** Validates in draft mode and inserts a draft with its lines; the shared path of `entry.create`, `entry.from_template` and the opening balances. */
export async function createDraft(ctx: ProcessContext, input: EntryInput, origin: EntryOrigin, extraColumns: Record<string, unknown> = {}): Promise<string> {
  const journalId = await defaultJournal(ctx, input.journalId);
  const lines = await inheritParty(ctx, input.partyId, input.lines);
  assertValid(await validateLines(ctx, { journalId, date: input.date, businessUnitId: input.businessUnitId, origin }, lines, "draft"));
  const [entry] = await ctx.tx<{ id: string }[]>`
    insert into accounting.entries ${ctx.tx({
      company_id: ctx.companyId, journal_id: journalId, date: input.date, description: input.description, currency: input.currency,
      exchange_rate: input.exchangeRate, business_unit_id: input.businessUnitId ?? null, reverse_on: input.reverseOn ?? null,
      origin, status: "draft", ...extraColumns,
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
  description: "Crea un comprobante manual en borrador con sus líneas; el consecutivo se asigna al contabilizar",
  input: entryInput,
  output: idOutput,
  handler: async (ctx, input) => {
    const custom = await extraForCreate(ctx, "accounting.entry", "accounting.entry.create", input);
    const columns = Object.fromEntries(Object.entries(custom).filter(([, value]) => value !== undefined));
    return { id: await createDraft(ctx, input, "manual", columns) };
  },
});

export const entryUpdate = defineProcess({
  id: "accounting.entry.update",
  module: "accounting",
  kind: "update",
  feature: "accounting.ledger",
  description: "Reemplaza el encabezado y las líneas de un borrador; un comprobante pendiente de aprobación vuelve a borrador",
  input: z.object({ id, ...entryHeaderShape, extraPatch }).strict(),
  output: idOutput,
  handler: async (ctx, { id: entryId, extraPatch: patch, ...input }) => {
    const [current] = await ctx.tx<{ status: string; origin: EntryOrigin; journal_id: string; extra: Record<string, unknown> }[]>`
      select status, origin, journal_id, extra from accounting.entries where id = ${entryId} and company_id = ${ctx.companyId} for update`;
    if (!current) throw new ProcessError("not_found", `entry ${entryId} not found`);
    if (current.status !== "draft" && current.status !== "pending") {
      throw invalid(`entry ${entryId} is ${current.status}`, "Solo se puede modificar un borrador o un comprobante pendiente de aprobación; uno contabilizado se corrige con una reversión");
    }
    const journalId = input.journalId ?? current.journal_id;
    const lines = await inheritParty(ctx, input.partyId, input.lines);
    assertValid(await validateLines(ctx, { journalId, date: input.date, businessUnitId: input.businessUnitId, origin: current.origin }, lines, "draft"));
    const custom = await extraForUpdate(ctx, "accounting.entry", "accounting.entry.update", current.extra, { ...input, extraPatch: patch });
    // The status goes back to draft first: the lines of an entry that is not a draft are frozen.
    await ctx.tx`
      update accounting.entries set ${ctx.tx({
        status: "draft", submitted_by: null, submitted_at: null, journal_id: journalId, date: input.date, description: input.description,
        currency: input.currency, exchange_rate: input.exchangeRate, business_unit_id: input.businessUnitId ?? null, reverse_on: input.reverseOn ?? null,
        ...Object.fromEntries(Object.entries(custom).filter(([, value]) => value !== undefined)),
      })} where id = ${entryId}`;
    await ctx.tx`delete from accounting.entry_lines where entry_id = ${entryId}`;
    await insertLines(ctx, entryId, input.exchangeRate, lines);
    return { id: entryId };
  },
});

export const entryVoid = defineProcess({
  id: "accounting.entry.void",
  module: "accounting",
  kind: "update",
  feature: "accounting.ledger",
  description: "Anula un borrador o un comprobante pendiente de aprobación; la fila queda con estado anulado y el motivo",
  input: z.object({ id, reason: z.string().trim().min(1).max(500) }).strict(),
  output: idOutput,
  handler: async (ctx, { id: entryId, reason }) => {
    const [current] = await ctx.tx<{ status: string }[]>`select status from accounting.entries where id = ${entryId} and company_id = ${ctx.companyId} for update`;
    if (!current) throw new ProcessError("not_found", `entry ${entryId} not found`);
    if (current.status !== "draft" && current.status !== "pending") {
      throw invalid(`entry ${entryId} is ${current.status}`, "Solo se anula un borrador o un comprobante pendiente; uno contabilizado se corrige con una reversión");
    }
    await ctx.tx`
      update accounting.entries
         set status = 'voided', extra = extra || ${ctx.tx.json({ void_reason: reason })}
       where id = ${entryId}`;
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
    return { ...row, id: entryId, extra: await visibleExtra(ctx, "accounting.entry", row.extra), lines: await entryLinesOf(ctx, entryId) };
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

export const ENTRY_PROCESSES = [entryCreate, entryUpdate, entryVoid, entryConsult, entryLineConsult];
