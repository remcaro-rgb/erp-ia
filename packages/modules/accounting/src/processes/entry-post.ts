import { assertRecordRight, assertReferencesUsable, defineProcess, emitStatusChanged, ProcessError, writeSnapshot, type ProcessContext, type RecordStatus, type TypedRecord } from "@erp/kernel";
import { z } from "zod";
import { invalid, OPEN_ENTRY_STATES } from "./common";
import { assertValid, validateLines, type EntryOrigin, type LineInput } from "./entry-validate";
import { id } from "./schemas";
import { resolveRoleAccount } from "./mapping";

// Posting (accounting design §4.6, §5.5, §5.12; entity types spec 2026-11-02 D8, Phase 2A.5 Task 8b). A person posts a comprobante
// with its lifecycle: Grabar (no approval) or Aprobar (approval) runs, in one transaction, the comprobante's validate, number and post
// hooks (entry-lifecycle.ts), and the post hook is `completePosting` below. The module's internal paths post a Borrador directly with
// `postEntry` (the same steps, in the same order): the posting engine (`entry.post_from_event`), the reversals, the opening balances
// (`opening.post`, under step-up) and the year close. Auto-reversing accruals and reversals live here too.

export interface PostOptions {
  /** The posting engine's rule is already an admin's decision: account grants (`can_post`) do not apply (§4.15). */
  engine?: boolean;
}

export interface EntryRow {
  id: string;
  journal_id: string;
  date: string;
  status: string;
  origin: EntryOrigin;
  created_by: string | null;
  business_unit_id: string | null;
  reverse_on: string | null;
  is_auto_reversal: boolean;
  reversal_of_id: string | null;
  currency: string;
  exchange_rate: string;
  source_entity: string | null;
  source_record_id: string | null;
  is_closing: boolean;
  is_opening: boolean;
  extra: Record<string, unknown> | null;
}

const ENTRY_COLUMNS = `id, journal_id, date::text as date, status, origin, created_by, business_unit_id, reverse_on::text as reverse_on, is_auto_reversal,
  reversal_of_id, currency, exchange_rate, source_entity, source_record_id, is_closing, is_opening, extra`;

/** The comprobante, locked. */
export async function lockEntry(ctx: ProcessContext, entryId: string): Promise<EntryRow & { number: string | null }> {
  const [entry] = await ctx.tx.unsafe<(EntryRow & { number: string | null })[]>(
    `select ${ENTRY_COLUMNS}, number from accounting.entries where id = $1 and company_id = $2 for update`, [entryId, ctx.companyId]);
  if (!entry) throw new ProcessError("not_found", `entry ${entryId} not found`);
  return entry;
}

interface LineRow {
  line_no: number;
  account_id: string;
  party_id: string | null;
  cost_center_id: string | null;
  open_auxiliary_id: string | null;
  item_id: string | null;
  business_unit_id: string | null;
  description: string | null;
  debit: string;
  credit: string;
  debit_doc: string;
  credit_doc: string;
  tax_code: string | null;
  tax_rate: string | null;
  tax_base: string | null;
  reference: string | null;
  due_date: string | null;
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

export const linesOf = (ctx: ProcessContext, entryId: string) =>
  ctx.tx<LineRow[]>`select line_no, account_id, party_id, cost_center_id, open_auxiliary_id, item_id, business_unit_id, description, debit, credit,
                           debit_doc, credit_doc, tax_code, tax_rate, tax_base, reference, due_date::text
                    from accounting.entry_lines where entry_id = ${entryId} order by line_no`;

export const asInput = (line: LineRow): LineInput => ({
  accountId: line.account_id, partyId: line.party_id, costCenterId: line.cost_center_id, openAuxiliaryId: line.open_auxiliary_id,
  itemId: line.item_id, businessUnitId: line.business_unit_id, description: line.description, debit: Number(line.debit), credit: Number(line.credit),
  taxCode: line.tax_code, taxRate: line.tax_rate === null ? null : Number(line.tax_rate), taxBase: line.tax_base === null ? null : Number(line.tax_base),
  reference: line.reference, dueDate: line.due_date,
});

/** The mirrored lines of an entry, debit and credit swapped, for a reversal or an auto-reversal. */
export async function insertMirror(ctx: ProcessContext, from: string, to: string): Promise<void> {
  await ctx.tx`
    insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, party_id, cost_center_id, open_auxiliary_id, item_id, business_unit_id,
                                        description, debit, credit, debit_doc, credit_doc, tax_code, tax_rate, tax_base, reference, due_date)
    select company_id, ${to}, line_no, account_id, party_id, cost_center_id, open_auxiliary_id, item_id, business_unit_id,
           description, credit, debit, credit_doc, debit_doc, tax_code, tax_rate, tax_base, reference, due_date
    from accounting.entry_lines where entry_id = ${from}`;
}

/** The header facts the line rules need, from the stored comprobante. */
export const headerOf = (entry: EntryRow) => ({
  journalId: entry.journal_id, date: entry.date, businessUnitId: entry.business_unit_id, origin: entry.origin, isClosing: entry.is_closing,
});

/** Checks the stored lines of a comprobante as a ledger entry must satisfy them (§5.5); refuses with `invalid_input` (code first). */
export async function assertPostable(ctx: ProcessContext, entry: EntryRow, opts: PostOptions = {}): Promise<void> {
  const lines = (await linesOf(ctx, entry.id)).map(asInput);
  assertValid(await validateLines(ctx, headerOf(entry), lines, "post", { engine: opts.engine === true }));
}

/**
 * The posting step of a comprobante that is already validated and numbered (`number`): adds the rounding line when the difference
 * is within the tolerance, stores the resolved business unit on every line, sets the period and who posted it, creates the
 * auto-reversal draft when `reverse_on` is set, marks the original reversed when this is that draft (`extra.reversed`, D2: the
 * original stays Contabilizado) and emits `accounting.entry.posted`. The status is the caller's: the lifecycle runner sets it after
 * the post hook, `postEntry` itself. The lines are written in this step while the comprobante is Grabado or Aprobado: the
 * transaction-local setting accounting.posting_entry tells the line trigger (0043) which comprobante is posting.
 */
export async function completePosting(ctx: ProcessContext, entry: EntryRow, number: string): Promise<{ periodId: string }> {
  const entryId = entry.id;
  const stored = await linesOf(ctx, entryId);
  const lines = stored.map(asInput);
  const rate = Number(entry.exchange_rate);
  const debit = round4(lines.reduce((sum, l) => sum + l.debit, 0));
  const credit = round4(lines.reduce((sum, l) => sum + l.credit, 0));
  const difference = round4(debit - credit);
  let rounding: { accountId: string } | null = null;
  if (difference !== 0) {
    rounding = await resolveRoleAccount(ctx, "rounding");
    if (!rounding) {
      throw new ProcessError("invalid_input", "missing_account_mapping: no account is mapped to the rounding role", { details: ["Falta mapear la cuenta del rol «ajuste al peso» (rounding)"] });
    }
  }
  const [period] = await ctx.tx<{ id: string }[]>`
    select id from accounting.periods where company_id = ${ctx.companyId} and ${entry.date}::date between starts_on and ends_on`;

  await ctx.tx`select set_config('accounting.posting_entry', ${entryId}, true)`;
  if (entry.business_unit_id) {
    await ctx.tx`update accounting.entry_lines set business_unit_id = ${entry.business_unit_id} where entry_id = ${entryId} and business_unit_id is null`;
  }
  if (rounding) {
    const side = difference > 0 ? { debit: 0, credit: difference } : { debit: -difference, credit: 0 };
    await ctx.tx`
      insert into accounting.entry_lines ${ctx.tx({
        company_id: ctx.companyId, entry_id: entryId, line_no: stored.length + 1, account_id: rounding.accountId, description: "Ajuste al peso",
        debit: side.debit, credit: side.credit, debit_doc: round4(side.debit / rate), credit_doc: round4(side.credit / rate),
      })}`;
  }
  await ctx.tx`select set_config('accounting.posting_entry', '', true)`;
  await ctx.tx`update accounting.entries set period_id = ${period!.id}, posted_at = now(), posted_by = ${ctx.userId} where id = ${entryId}`;

  if (entry.reverse_on) {
    const [auto] = await ctx.tx<{ id: string }[]>`
      insert into accounting.entries ${ctx.tx({
        company_id: ctx.companyId, journal_id: entry.journal_id, date: entry.reverse_on, description: `Reversión automática de ${number}`,
        origin: "auto", status: "draft", requires_approval: false, posts: true, is_auto_reversal: true, reversal_of_id: entryId,
        business_unit_id: entry.business_unit_id, currency: entry.currency, exchange_rate: entry.exchange_rate, source_entity: entry.source_entity,
        source_record_id: entry.source_record_id, chain_id: ctx.chainId,
      })}
      on conflict (reversal_of_id) where is_auto_reversal do nothing
      returning id`;
    if (auto) {
      await insertMirror(ctx, entryId, auto.id);
      await ctx.tx`update accounting.entries set reversed_by_id = ${auto.id} where id = ${entryId}`;
    }
  }
  if (entry.is_auto_reversal && entry.reversal_of_id) {
    await ctx.tx`update accounting.entries set extra = extra || '{"reversed": true}'::jsonb where id = ${entry.reversal_of_id} and status = 'posted'`;
  }

  await ctx.emit("accounting.entry.posted", {
    entryId, number, journalId: entry.journal_id, date: entry.date, periodId: period!.id, origin: entry.origin,
    sourceEntity: entry.source_entity, sourceRecordId: entry.source_record_id, totalDebit: round4(Math.max(debit, credit)),
  });
  return { periodId: period!.id };
}

/** The next consecutivo of the comprobante's Fuente (D9: numbered at posting). */
export async function nextEntryNumber(ctx: ProcessContext, journalId: string): Promise<string> {
  const [numbered] = await ctx.tx<{ number: string }[]>`select accounting.next_entry_number(${journalId}) as number`;
  return numbered!.number;
}

/** The posting failure code (design §5.5) an unusable maestro is recorded under when the engine posts: the message leads with it. */
const FAILURE_OF: Readonly<Record<string, string>> = {
  "accounting.account": "inactive_account",
  "accounting.journal": "no_journal",
  "core.party": "missing_party",
};

/**
 * D10 (usability "again at Contabilizar"; review of Task 8b, Important 1): the maestros a comprobante names, on its header and its
 * lines, must be usable when an internal path posts it, as the lifecycle checks them at Grabar and Aprobar. Same gate as the
 * runner's (`kernel.record_usable`), same code `maestro_not_usable`, same transaction. The one exemption (controller ruling of
 * 2026-11-02): a reversal of a posted comprobante (entry.reverse, the automatic reversal of an accrual, the year reopen) mirrors
 * lines that were valid when they posted, and a correction is never blocked by a later approval change of a maestro.
 *
 * Only the usability applies here, not the caller's record rights (ruling of 2026-11-02 on Task 9 review I2): every caller of
 * postEntry is a system path whose references the system chose (the engine's rules and mappings, the opening, the year close), so the
 * caller's read and use rights on them (kernel.record_access) are not checked. A person's Grabar / Aprobar keeps the use right.
 */
async function assertMaestrosUsable(ctx: ProcessContext, entry: EntryRow): Promise<void> {
  if (entry.reversal_of_id) return;
  try {
    await assertReferencesUsable(ctx, ctx.registry.entity("accounting.entry"), entry as unknown as TypedRecord, { callerRights: false });
  } catch (error) {
    if (!(error instanceof ProcessError) || error.code !== "maestro_not_usable") throw error;
    const target = String((error.details as { entity?: unknown } | undefined)?.entity ?? "");
    const failure = FAILURE_OF[target] ?? "inactive_dimension";
    throw new ProcessError("maestro_not_usable", `${failure}: maestro_not_usable: ${error.message}`, { details: error.details });
  }
}

/**
 * Posts a Borrador from one of the module's internal paths (engine, reversal, opening balances, year close): validates it as §5.5
 * says, assigns the Fuente's consecutivo, runs the posting step, marks it Contabilizado and snapshots it (§8). A person's comprobante
 * is posted by its lifecycle instead (Grabar / Aprobar). A refusal throws `invalid_input` whose message leads with the failure code.
 */
export async function postEntry(ctx: ProcessContext, entryId: string, opts: PostOptions = {}): Promise<{ id: string; number: string; periodId: string }> {
  const entry = await lockEntry(ctx, entryId);
  if (entry.status !== "draft") {
    throw invalid(`entry_not_postable: entry ${entryId} is ${entry.status}`, entry.status === "posted" ? "El comprobante ya está contabilizado" : "Solo se contabiliza así un comprobante en borrador");
  }
  await assertMaestrosUsable(ctx, entry);
  await assertPostable(ctx, entry, opts);
  const number = await nextEntryNumber(ctx, entry.journal_id);
  await ctx.tx`update accounting.entries set number = ${number} where id = ${entryId}`;
  const { periodId } = await completePosting(ctx, entry, number);
  await ctx.tx`update accounting.entries set status = 'posted' where id = ${entryId}`;
  await writeSnapshot(ctx, ctx.registry.entity("accounting.entry"), entryId, "posted", null);
  // The state e-mails (Task 12): the comprobante entered Contabilizado, in this transaction, in the name of the person behind the run.
  await emitStatusChanged(ctx, ctx.registry.entity("accounting.entry"), { id: entryId, number }, entry.status as RecordStatus, "posted");
  return { id: entryId, number, periodId };
}

const postOutput = z.object({ id: z.string(), number: z.string() });

/**
 * Reverses a posted comprobante with a mirrored one in the same Fuente, dated `date` (today by default) in an open period: links
 * both ways, marks the original reversed (`extra.reversed`; it stays Contabilizado, D2), voids an auto-reversal that has not posted
 * yet so the entry is not reversed twice. The year-close
 * entries are reversed only by `year.reopen`, which passes `allowClosing`.
 */
export async function reverseEntry(
  ctx: ProcessContext,
  entryId: string,
  input: { date?: string | undefined; reason: string },
  opts: { allowClosing?: boolean; engine?: boolean } = {},
): Promise<{ id: string; number: string }> {
  const original = await lockEntry(ctx, entryId);
  if (original.status !== "posted" || original.extra?.reversed === true) throw invalid(`entry ${entryId} is ${original.status}`, "Solo se revierte un comprobante contabilizado que no haya sido revertido");
  if (original.reversal_of_id) throw invalid(`entry ${entryId} is a reversal`, "Un comprobante de reversión no se revierte: crea uno nuevo");
  if (original.is_closing && !opts.allowClosing) {
    throw invalid(`entry ${entryId} is a closing entry`, "Los comprobantes de cierre del año se revierten reabriendo el año fiscal (year.reopen)");
  }
  // An auto-reversal that has not posted would reverse it a second time: the system voids it, and the documento keeps the snapshot
  // of that step with its reason (§8; review of Task 8b, minor 9).
  const replaced = `Reemplazado por la reversión de ${original.number}`;
  const voided = await ctx.tx<{ id: string; number: string | null; previous: RecordStatus }[]>`
    with open as (
      select id, status from accounting.entries
       where reversal_of_id = ${entryId} and is_auto_reversal and status = any(${[...OPEN_ENTRY_STATES]}::text[])
       for update
    )
    update accounting.entries e set status = 'voided', void_reason = ${replaced}
      from open where e.id = open.id
    returning e.id, e.number, open.status as previous`;
  for (const auto of voided) {
    await writeSnapshot(ctx, ctx.registry.entity("accounting.entry"), auto.id, "voided", replaced);
    await emitStatusChanged(ctx, ctx.registry.entity("accounting.entry"), auto, auto.previous, "voided");
  }
  const [reversal] = await ctx.tx<{ id: string }[]>`
    insert into accounting.entries ${ctx.tx({
      company_id: ctx.companyId, journal_id: original.journal_id, date: input.date ?? new Date().toISOString().slice(0, 10),
      description: `Reversión de ${original.number}: ${input.reason}`, origin: "auto", status: "draft", requires_approval: false, posts: true, reversal_of_id: entryId,
      business_unit_id: original.business_unit_id, currency: original.currency, exchange_rate: original.exchange_rate, source_entity: original.source_entity,
      source_record_id: original.source_record_id, chain_id: ctx.chainId, is_opening: original.is_opening, is_closing: original.is_closing,
    })}
    returning id`;
  await insertMirror(ctx, entryId, reversal!.id);
  // `engine`: a reversal ordered by an event (an inline void) is the ledger rules' decision, like the engine's own posting: not narrowed by
  // the account grants of the person who triggered it.
  const posted = await postEntry(ctx, reversal!.id, opts.engine ? { engine: true } : {});
  await ctx.tx`update accounting.entries set extra = extra || '{"reversed": true}'::jsonb, reversed_by_id = ${reversal!.id} where id = ${entryId}`;
  await ctx.emit("accounting.entry.reversed", { entryId, reversalId: reversal!.id, number: original.number, reversalNumber: posted.number, reason: input.reason });
  return { id: reversal!.id, number: posted.number };
}

export const entryReverse = defineProcess({
  id: "accounting.entry.reverse",
  module: "accounting",
  kind: "create",
  recordAccess: "handler",
  feature: "accounting.ledger",
  description: "Revierte un comprobante contabilizado con otro de líneas espejo en la misma fuente y en un período abierto",
  emits: ["accounting.entry.reversed", "accounting.entry.posted"],
  idempotencyKey: (input) => `reverse:${input.id}`,
  input: z.object({ id, date: z.iso.date().optional(), reason: z.string().trim().min(1).max(500) }).strict(),
  output: postOutput,
  handler: async (ctx, { id: entryId, date, reason }) => {
    // Revertir is the Anular of a Contabilizado comprobante (D3): it needs the record-level void right on it (spec §9.1, Task 9).
    await assertRecordRight(ctx, "accounting.entry", entryId, "void");
    return reverseEntry(ctx, entryId, { date, reason });
  },
});

export const ENTRY_POST_PROCESSES = [entryReverse];
