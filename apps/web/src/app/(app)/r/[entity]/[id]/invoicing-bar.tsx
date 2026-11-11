"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { StepUpPrompt, useRecordBridge, useTabs } from "@erp/ui";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@erp/ui/components/ui/dialog";
import { handOffNote } from "@/lib/invoicing/note-handoff";
import { runInvoicingStepAction } from "@/lib/invoicing/step-actions";
import type { InvoicingView } from "@/lib/invoicing/record";
import { useStepRunner } from "@/lib/records/use-step-runner";

// The invoice's and the note's own buttons in the record bar (plan 2B Task 20 fix round 1, prototype 2B lines 614-615), on every tab, next
// to Guardar: «Emitir» (a Borrador; one idempotency key per click), «Reintentar envío» (shown disabled with why when there is nothing to
// resend) and «Anular (nota crédito)», whose dialog (prototype openVoid) says what it issues: the annulment credit note, its concept, its
// value and its own numbering, and that it asks for the verification code (rule 15). A note's «Duplicar» (rule 37) opens its invoice with
// the «Crear nota» panel started from the note (a note is always written from its invoice). The server picks each process (INVOICING_STEPS).

export function InvoicingBarActions({ entity, recordId, view, updatedAt = null }: { entity: string; recordId: string; view: InvoicingView; updatedAt?: string | null }) {
  const t = useTranslations("invoicing.view");
  const te = useTranslations("errors");
  const router = useRouter();
  const openTab = useTabs((s) => s.open);
  const bridge = useRecordBridge();
  const dirty = bridge?.state.dirty ?? false;
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const step = useStepRunner(
    (name: string, input, token) => runInvoicingStepAction(entity, name, recordId, input, token),
    () => {
      setVoiding(false);
      setReason("");
      router.refresh();
    },
    { clickKey: true },
  );
  const { bar } = view;
  const failure = step.failure ? (step.failure.messages.length > 0 ? step.failure.messages.join(" · ") : te.has(step.failure.code) ? te(step.failure.code) : te("unknown")) : null;

  const duplicate = () => {
    if (!view.noteSource) return;
    handOffNote(view.noteSource.invoiceId, view.noteSource.source);
    const href = `/r/invoicing.invoice/${view.noteSource.invoiceId}`;
    openTab({ title: t("duplicate"), href, kind: "record" });
    router.push(href);
  };

  return (
    <>
      {bar.issue && (
        <button type="button" data-action="issue" className="erp-btn erp-btn--primary erp-touch" disabled={step.busy || dirty} title={dirty ? t("unsaved_issue") : undefined} onClick={() => step.run("issue")}>
          {t("issue")}
        </button>
      )}
      {bar.reprice && (
        <button type="button" data-action="reprice" className="erp-btn erp-touch" disabled={step.busy || dirty} title={dirty ? t("unsaved_issue") : t("reprice_hint")} onClick={() => step.run("reprice")}>
          {t("reprice")}
        </button>
      )}
      {bar.resubmit && (
        <button type="button" data-action="resubmit" className="erp-btn erp-touch" disabled={step.busy || bar.resubmit.block !== null} title={bar.resubmit.block ?? undefined} onClick={() => step.run("resubmit")}>
          {t("resubmit")}
        </button>
      )}
      {bar.void && (
        <button type="button" data-action="void-note" className="erp-btn erp-btn--danger erp-touch" disabled={step.busy || bar.void.block !== null} title={bar.void.block ?? t("void_hint")} onClick={() => (step.clear(), setVoiding(true))}>
          {t("void")}
        </button>
      )}
      {bar.duplicate && (
        <button type="button" data-action="duplicate-note" className="erp-btn erp-touch" disabled={step.busy || bar.duplicate.block !== null} title={bar.duplicate.block ?? t("duplicate_hint")} onClick={duplicate}>
          {t("duplicate")}
        </button>
      )}
      {step.busy && !voiding && <span className="erp-small erp-muted">{t("working")}</span>}
      {failure && !voiding && (
        <span role="alert" className="erp-dian erp-dian--bad erp-actbar__alert">
          {failure}
        </span>
      )}
      {step.stepUp && !voiding && <StepUpPrompt onConfirm={(code) => void step.confirm(code)} onCancel={step.cancel} error={step.stepUpError} busy={step.busy} />}
      {bar.void && bar.voidPreview && (
        <Dialog open={voiding} onOpenChange={(open) => !open && !step.busy && (step.cancel(), setVoiding(false))}>
          <DialogContent className="erp-dialog">
            <DialogTitle className="erp-dialog__title">{t("void_dialog.title", { number: bar.name })}</DialogTitle>
            <DialogDescription asChild>
              <div className="erp-dian erp-dian--warn">{t.rich("void_dialog.explain", { number: bar.name, b: (c) => <b>{c}</b> })}</div>
            </DialogDescription>
            <section className="erp-dian" aria-label={t("void_dialog.preview")}>
              <b>{t("void_dialog.preview")}</b>
              <br />
              {t.rich("void_dialog.kind", { concept: bar.voidPreview.concept, b: (c) => <b>{c}</b> })}
              <br />
              {t("void_dialog.reference")}
              <br />
              <span data-testid="void-value">{t.rich("void_dialog.value", { total: bar.voidPreview.total, b: (c) => <b>{c}</b> })}</span>
              <br />
              {bar.voidPreview.numbering ? t("void_dialog.numbering", { numbering: bar.voidPreview.numbering }) : t("void_dialog.numbering_missing")}
            </section>
            <div className="erp-field">
              <label htmlFor={reasonId}>{t("void_dialog.reason")}</label>
              <input id={reasonId} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="erp-dian erp-dian--info">{t.rich("void_dialog.step_up", { b: (c) => <b>{c}</b> })}</div>
            {failure && (
              <div role="alert" className="erp-dian erp-dian--bad">
                {failure}
              </div>
            )}
            {step.stepUp && <StepUpPrompt onConfirm={(code) => void step.confirm(code)} onCancel={step.cancel} error={step.stepUpError} busy={step.busy} />}
            <div className="erp-row">
              <span className="erp-grow" />
              <button type="button" className="erp-btn" disabled={step.busy} onClick={() => (step.cancel(), setVoiding(false))}>
                {t("void_dialog.cancel")}
              </button>
              <button type="button" className="erp-btn erp-btn--danger" disabled={step.busy || reason.trim() === ""} onClick={() => step.run("void", { reason, ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}) })}>
                {t("void_dialog.confirm")}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
