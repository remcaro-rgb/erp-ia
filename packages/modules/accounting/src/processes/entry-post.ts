import { defineProcess, ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { invalid, settingsOf } from "./common";
import { assertValid, validateLines, type EntryOrigin, type LineInput } from "./entry-validate";
import { id } from "./schemas";
import { resolveRoleAccount } from "./mapping";

// Posting (accounting design §4.6, §5.5, §5.12): `postEntry` is the one function that takes a comprobante out of draft. Humans and
// the assistant reach it through `entry.post`, the engine through `entry.post_from_event` (Task 20), the opening balances through
// `opening.post`. Submit, four-eyes approval, auto-reversing accruals and reversals live here.

export interface PostOptions {
  /** `human` runs the four-eyes control of a manual entry; `event` is the posting engine. */
  origin: "human" | "event";
  /** The opening balances are posted by a person under step-up: no second approver. */
  skipFourEyes?: boolean;
}

interface EntryRow {
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
  exchange_rate: string;
  source_entity: string | null;
  source_record_id: string | null;
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

const linesOf = (ctx: ProcessContext, entryId: string) =>
  ctx.tx<LineRow[]>`select line_no, account_id, party_id, cost_center_id, open_auxiliary_id, item_id, business_unit_id, description, debit, credit,
                           debit_doc, credit_doc, tax_code, tax_rate, tax_base, reference, due_date::text
                    from accounting.entry_lines where entry_id = ${entryId} order by line_no`;

const asInput = (line: LineRow): LineInput => ({
  accountId: line.account_id, partyId: line.party_id, costCenterId: line.cost_center_id, openAuxiliaryId: line.open_auxiliary_id,
  itemId: line.item_id, businessUnitId: line.business_unit_id, description: line.description, debit: Number(line.debit), credit: Number(line.credit),
  taxCode: line.tax_code, taxRate: line.tax_rate === null ? null : Number(line.tax_rate), taxBase: line.tax_base === null ? null : Number(line.tax_base),
  reference: line.reference, dueDate: line.due_date,
});

/** The mirrored lines of an entry, debit and credit swapped, for a reversal or an auto-reversal. */
async function insertMirror(ctx: ProcessContext, from: string, to: string): Promise<void> {
  await ctx.tx`
    insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, party_id, cost_center_id, open_auxiliary_id, item_id, business_unit_id,
                                        description, debit, credit, debit_doc, credit_doc, tax_code, tax_rate, tax_base, reference, due_date)
    select company_id, ${to}, line_no, account_id, party_id, cost_center_id, open_auxiliary_id, item_id, business_unit_id,
           description, credit, debit, credit_doc, debit_doc, tax_code, tax_rate, tax_base, reference, due_date
    from accounting.entry_lines where entry_id = ${from}`;
}

/**
 * Posts a draft (or pending) comprobante: validates it as §5.5 says, adds the rounding line when the difference is within the
 * tolerance, stores the resolved business unit on every line, assigns the Fuente's consecutivo and the period, marks it posted,
 * creates the auto-reversal draft when `reverse_on` is set, marks the original reversed when this is that draft, and emits
 * `accounting.entry.posted`. A refusal throws `invalid_input` whose message leads with the failure code.
 */
export async function postEntry(ctx: ProcessContext, entryId: string, opts: PostOptions): Promise<{ id: string; number: string; periodId: string }> {
  const [entry] = await ctx.tx<EntryRow[]>`
    select id, journal_id, date::text, status, origin, created_by, business_unit_id, reverse_on::text, is_auto_reversal, reversal_of_id,
           exchange_rate, source_entity, source_record_id
    from accounting.entries where id = ${entryId} and company_id = ${ctx.companyId} for update`;
  if (!entry) throw new ProcessError("not_found", `entry ${entryId} not found`);
  if (entry.status !== "draft" && entry.status !== "pending") {
    throw invalid(`entry_not_postable: entry ${entryId} is ${entry.status}`, `El comprobante ya está ${entry.status === "posted" ? "contabilizado" : entry.status === "reversed" ? "revertido" : "anulado"}`);
  }
  const settings = await settingsOf(ctx);
  if (opts.origin === "human" && !opts.skipFourEyes && settings?.requireApprovalOnManual && entry.origin !== "auto") {
    if (entry.status !== "pending") {
      throw invalid("pending_approval: the entry must be sent to approval first", "Con la aprobación activada el comprobante se envía a aprobación antes de contabilizarse");
    }
    if (entry.created_by === ctx.userId) {
      throw new ProcessError("invalid_input", "same_user_approval: the creator cannot approve their own entry", { details: ["Quien creó el comprobante no puede aprobarlo: debe contabilizarlo otra persona"] });
    }
  }

  const stored = await linesOf(ctx, entryId);
  const lines = stored.map(asInput);
  assertValid(await validateLines(ctx, { journalId: entry.journal_id, date: entry.date, businessUnitId: entry.business_unit_id, origin: entry.origin }, lines, "post"));

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
  const [numbered] = await ctx.tx<{ number: string }[]>`select accounting.next_entry_number(${entry.journal_id}) as number`;

  // Lines are written only while the entry is a draft (§4.7): a pending entry goes back to draft for the last writes.
  await ctx.tx`update accounting.entries set status = 'draft' where id = ${entryId}`;
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
  await ctx.tx`
    update accounting.entries
       set status = 'posted', number = ${numbered!.number}, period_id = ${period!.id}, posted_at = now(), posted_by = ${ctx.userId}
     where id = ${entryId}`;

  if (entry.reverse_on) {
    const [auto] = await ctx.tx<{ id: string }[]>`
      insert into accounting.entries ${ctx.tx({
        company_id: ctx.companyId, journal_id: entry.journal_id, date: entry.reverse_on, description: `Reversión automática de ${numbered!.number}`,
        origin: "auto", status: "draft", is_auto_reversal: true, reversal_of_id: entryId, business_unit_id: entry.business_unit_id,
        exchange_rate: entry.exchange_rate, source_entity: entry.source_entity, source_record_id: entry.source_record_id, chain_id: ctx.chainId,
      })}
      on conflict (reversal_of_id) where is_auto_reversal do nothing
      returning id`;
    if (auto) {
      await insertMirror(ctx, entryId, auto.id);
      await ctx.tx`update accounting.entries set reversed_by_id = ${auto.id} where id = ${entryId}`;
    }
  }
  if (entry.is_auto_reversal && entry.reversal_of_id) {
    await ctx.tx`update accounting.entries set status = 'reversed' where id = ${entry.reversal_of_id} and status = 'posted'`;
  }

  await ctx.emit("accounting.entry.posted", {
    entryId, number: numbered!.number, journalId: entry.journal_id, date: entry.date, periodId: period!.id, origin: entry.origin,
    sourceEntity: entry.source_entity, sourceRecordId: entry.source_record_id, totalDebit: round4(Math.max(debit, credit)),
  });
  return { id: entryId, number: numbered!.number, periodId: period!.id };
}

const postOutput = z.object({ id: z.string(), number: z.string() });

export const entrySubmit = defineProcess({
  id: "accounting.entry.submit",
  module: "accounting",
  kind: "update",
  feature: "accounting.ledger",
  description: "Envía un borrador a aprobación: queda pendiente y de solo lectura hasta que otra persona lo contabilice",
  emits: ["accounting.entry.submitted"],
  input: z.object({ id }).strict(),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { id: entryId }) => {
    const [entry] = await ctx.tx<EntryRow[]>`
      select id, journal_id, date::text, status, origin, created_by, business_unit_id, reverse_on::text, is_auto_reversal, reversal_of_id,
             exchange_rate, source_entity, source_record_id
      from accounting.entries where id = ${entryId} and company_id = ${ctx.companyId} for update`;
    if (!entry) throw new ProcessError("not_found", `entry ${entryId} not found`);
    if (entry.status !== "draft") throw invalid(`entry ${entryId} is ${entry.status}`, "Solo se envía a aprobación un borrador");
    if (entry.origin === "auto") throw invalid(`entry ${entryId} is automatic`, "Los comprobantes automáticos no pasan por aprobación: su control es la regla contable");
    const settings = await settingsOf(ctx);
    if (!settings?.requireApprovalOnManual) throw invalid("approval is off", "La aprobación de comprobantes manuales no está activada: contabiliza el borrador directamente");
    const lines = (await linesOf(ctx, entryId)).map(asInput);
    assertValid(await validateLines(ctx, { journalId: entry.journal_id, date: entry.date, businessUnitId: entry.business_unit_id, origin: entry.origin }, lines, "post"));
    await ctx.tx`update accounting.entries set status = 'pending', submitted_by = ${ctx.userId}, submitted_at = now() where id = ${entryId}`;
    await ctx.emit("accounting.entry.submitted", { entryId, submittedBy: ctx.userId, createdBy: entry.created_by });
    return { id: entryId };
  },
});

export const entryPost = defineProcess({
  id: "accounting.entry.post",
  module: "accounting",
  kind: "update",
  feature: "accounting.ledger",
  description: "Contabiliza un comprobante: valida, asigna el consecutivo de la fuente y el período; con la aprobación activada es la aprobación de otra persona",
  emits: ["accounting.entry.posted"],
  input: z.object({ id }).strict(),
  output: postOutput,
  handler: async (ctx, { id: entryId }) => {
    const posted = await postEntry(ctx, entryId, { origin: ctx.origin === "event" ? "event" : "human" });
    return { id: posted.id, number: posted.number };
  },
});

export const entryReverse = defineProcess({
  id: "accounting.entry.reverse",
  module: "accounting",
  kind: "create",
  feature: "accounting.ledger",
  description: "Revierte un comprobante contabilizado con otro de líneas espejo en la misma fuente y en un período abierto",
  emits: ["accounting.entry.reversed", "accounting.entry.posted"],
  idempotencyKey: (input) => `reverse:${input.id}`,
  input: z.object({ id, date: z.iso.date().optional(), reason: z.string().trim().min(1).max(500) }).strict(),
  output: postOutput,
  handler: async (ctx, { id: entryId, date, reason }) => {
    const [original] = await ctx.tx<(EntryRow & { number: string })[]>`
      select id, journal_id, date::text, status, origin, created_by, business_unit_id, reverse_on::text, is_auto_reversal, reversal_of_id,
             exchange_rate, source_entity, source_record_id, number
      from accounting.entries where id = ${entryId} and company_id = ${ctx.companyId} for update`;
    if (!original) throw new ProcessError("not_found", `entry ${entryId} not found`);
    if (original.status !== "posted") throw invalid(`entry ${entryId} is ${original.status}`, "Solo se revierte un comprobante contabilizado que no haya sido revertido");
    if (original.reversal_of_id) throw invalid(`entry ${entryId} is a reversal`, "Un comprobante de reversión no se revierte: crea uno nuevo");
    // A pending auto-reversal draft would reverse it a second time.
    await ctx.tx`
      update accounting.entries set status = 'voided', extra = extra || ${ctx.tx.json({ void_reason: `Reemplazado por la reversión de ${original.number}` })}
       where reversal_of_id = ${entryId} and is_auto_reversal and status in ('draft', 'pending')`;
    const [reversal] = await ctx.tx<{ id: string }[]>`
      insert into accounting.entries ${ctx.tx({
        company_id: ctx.companyId, journal_id: original.journal_id, date: date ?? new Date().toISOString().slice(0, 10),
        description: `Reversión de ${original.number}: ${reason}`, origin: "auto", status: "draft", reversal_of_id: entryId,
        business_unit_id: original.business_unit_id, exchange_rate: original.exchange_rate, source_entity: original.source_entity,
        source_record_id: original.source_record_id, chain_id: ctx.chainId,
      })}
      returning id`;
    await insertMirror(ctx, entryId, reversal!.id);
    const posted = await postEntry(ctx, reversal!.id, { origin: "event", skipFourEyes: true });
    await ctx.tx`update accounting.entries set status = 'reversed', reversed_by_id = ${reversal!.id} where id = ${entryId}`;
    await ctx.emit("accounting.entry.reversed", { entryId, reversalId: reversal!.id, number: original.number, reversalNumber: posted.number, reason });
    return { id: reversal!.id, number: posted.number };
  },
});

export const ENTRY_POST_PROCESSES = [entrySubmit, entryPost, entryReverse];
