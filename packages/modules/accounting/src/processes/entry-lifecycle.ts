import { ProcessError, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { entityDef } from "../entities";
import { invalid, settingsOf } from "./common";
import { assertReverseOn } from "./entry";
import { assertPostable, completePosting, lockEntry, nextEntryNumber, type EntryRow } from "./entry-post";
import { assertRefsExist, assertWritable, lifecycleProcesses, type LifecycleInput } from "./lifecycle";

// The comprobante on the typed-entity lifecycle (entity types spec 2026-11-02 §5, §8, D2, D3, D8, D9; Phase 2A.5 Task 8b). A
// comprobante is a documento that posts itself:
//   - Grabar (`accounting.entry.save`) without approval posts it in the same run: Borrador → Grabado → Contabilizado;
//   - with Requiere aprobación it stops at Grabado; Enviar a aprobación (`submit`) → Pendiente; Aprobar (`approve`) posts it;
//     No Aprobar (`reject`, reason required) → No Aprobado, which the creator edits and Graba again (it replaces Devolver a borrador);
//   - Anular (`void`, reason required) ends a Grabado, Pendiente, No Aprobado or Aprobado one; a Borrador is deleted instead
//     (`delete`), a Contabilizado one is reversed (`entry.reverse`).
// The kernel runner applies the transitions and the rollback (a refusal at posting leaves the comprobante as it was, with no number,
// snapshot or event); this file holds the comprobante's hooks and the accounting checks around the generic verbs.

/** The header columns entry.update writes; the lines change through entry.update, never through Grabar's `data`. */
const WRITABLE = new Set(["journal_id", "date", "description", "currency", "exchange_rate", "business_unit_id", "reverse_on", "extra", "extra_free"]);

const asEntry = (record: Record<string, unknown>) => record as unknown as EntryRow & { number: string | null };

/** The comprobante's lifecycle hooks: what Grabar, Aprobar and Contabiliza check and do (registered in index.ts). */
export const entryHooks: TypedHooks = {
  async validate(ctx, record, mode, change) {
    const entry = asEntry(record);
    if (mode === "save") {
      assertWritable("accounting.entry.save", change.data, WRITABLE);
      // Saldos iniciales are posted by a person under step-up (§5.8), never by Grabar.
      if (entry.is_opening) throw invalid(`opening_entry: entry ${entry.id} is an opening entry`, "Los saldos iniciales se contabilizan con «Contabilizar saldos iniciales» (verificación en dos pasos)");
      assertReverseOn(entry.date, entry.reverse_on);
      if (Number(entry.exchange_rate) !== Number(change.previous.exchange_rate)) {
        // The document-currency amounts follow a new rate, as entry.update derives them.
        await ctx.tx`
          update accounting.entry_lines
             set debit_doc = round(debit / ${Number(entry.exchange_rate)}, 4), credit_doc = round(credit / ${Number(entry.exchange_rate)}, 4)
           where entry_id = ${entry.id}`;
      }
      // A Grabado comprobante is complete: it is checked as a ledger entry (§5.5), whether it posts now or waits for approval.
      await assertPostable(ctx, entry);
      return;
    }
    if (mode === "approve") {
      // Four-eyes (§5.12): optional, off by default. With require_approval_on_manual a person's comprobante is approved by someone
      // else than its creator. Approval asked only in Parámetros (kernel.entity_type_settings) lets the creator approve (spec D5).
      const settings = await settingsOf(ctx);
      if (settings?.requireApprovalOnManual && entry.origin !== "auto" && entry.created_by === ctx.userId) {
        throw new ProcessError("invalid_input", "same_user_approval: the creator cannot approve their own entry", {
          details: ["Quien creó el comprobante no puede aprobarlo: debe aprobarlo otra persona"],
        });
      }
      return;
    }
    await assertPostable(ctx, entry);
  },
  /** D9: the Fuente's consecutivo, given at posting. */
  number: (ctx, record) => nextEntryNumber(ctx, String(record.journal_id)),
  /** D8: the posting step; the runner marks it Contabilizado and snapshots it afterwards. */
  async post(ctx, record) {
    await completePosting(ctx, asEntry(record), String(record.number));
  },
};

/** Eliminar (a Borrador only, D1) keeps the accounting refusals: the automatic reversal of an accrual, files, accounts the caller may not post. */
async function beforeDelete(ctx: ProcessContext, input: LifecycleInput): Promise<void> {
  const [entry] = await ctx.tx<{ is_auto_reversal: boolean }[]>`
    select is_auto_reversal from accounting.entries where id = ${input.id} and company_id = ${ctx.companyId}`;
  if (!entry) return; // the runner answers not_found
  if (entry.is_auto_reversal) {
    throw invalid(`entry ${input.id} is an automatic reversal`, "La reversión automática de un comprobante no se elimina: se contabiliza en su fecha o se anula al revertir el original");
  }
  const [files] = await ctx.tx<{ n: number }[]>`
    select count(*)::int as n from kernel.attachments where company_id = ${ctx.companyId} and entity = 'accounting.entry' and record_id = ${input.id} and removed_at is null`;
  if (files!.n > 0) throw invalid(`entry ${input.id} has attachments`, "El borrador tiene archivos adjuntos: quítalos antes de eliminarlo");
  const [forbidden] = await ctx.tx<{ code: string }[]>`
    select a.code from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id
    where l.entry_id = ${input.id} and not accounting.can_post_account(l.account_id) order by l.line_no limit 1`;
  if (forbidden) throw invalid(`account_forbidden: entry ${input.id} has lines on ${forbidden.code}`, `No tienes permiso para contabilizar en la cuenta ${forbidden.code}: no puedes eliminar este borrador`);
}

/** Enviar a aprobación checks the comprobante as a ledger entry, so the approver receives one that can post. */
async function beforeSubmit(ctx: ProcessContext, input: LifecycleInput): Promise<void> {
  const [exists] = await ctx.tx`select 1 from accounting.entries where id = ${input.id} and company_id = ${ctx.companyId}`;
  if (!exists) return;
  await assertPostable(ctx, await lockEntry(ctx, input.id));
}

/** Who sent it and when (the approval screen and the audit of §5.12), and the notification event. */
async function afterSubmit(ctx: ProcessContext, input: LifecycleInput): Promise<void> {
  const [entry] = await ctx.tx<{ created_by: string | null }[]>`
    update accounting.entries set submitted_by = ${ctx.userId}, submitted_at = now() where id = ${input.id} returning created_by`;
  await ctx.emit("accounting.entry.submitted", { entryId: input.id, submittedBy: ctx.userId, createdBy: entry?.created_by ?? null });
}

/** The comprobante's lifecycle processes (accounting declares them: its checks run around the kernel's verbs). */
export const ENTRY_LIFECYCLE_PROCESSES = lifecycleProcesses(entityDef("accounting.entry"), "accounting.ledger", {
  writable: WRITABLE,
  before: {
    save: (ctx, input) => assertRefsExist(ctx, input.data, {
      journal_id: { table: "accounting.journals", noun: "la fuente" }, business_unit_id: { table: "accounting.business_units", noun: "la unidad de negocio" },
    }),
    submit: beforeSubmit,
    delete: beforeDelete,
  },
  // No Aprobar is the kernel's verb as is: one status change on the header, the lines untouched (OD-1), the reason in its snapshot;
  // submitted_by / submitted_at keep who sent it last (the next Enviar a aprobación overwrites them).
  after: { submit: afterSubmit },
  descriptions: {
    save: "Graba un comprobante: sin aprobación lo contabiliza (asigna el consecutivo de la fuente y el período); con aprobación lo deja Grabado, listo para enviarlo a aprobación",
    submit: "Envía a aprobación un comprobante Grabado que requiere aprobación; queda Pendiente de Aprobación y de solo lectura",
    approve: "Aprueba un comprobante Pendiente de Aprobación y lo contabiliza; con la aprobación de comprobantes manuales activada, quien lo creó no puede aprobarlo",
    reject: "No aprueba un comprobante Pendiente de Aprobación, con el motivo; vuelve a quien lo creó como No Aprobado para corregirlo",
    void: "Anula un comprobante Grabado, Pendiente, No Aprobado o Aprobado con el motivo; uno contabilizado se corrige con una reversión",
    delete: "Elimina un comprobante en Borrador con sus líneas; no aplica a la reversión automática ni a un borrador con archivos",
  },
});
