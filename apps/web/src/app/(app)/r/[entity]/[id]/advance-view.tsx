"use client";

import { useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AdvanceApplyPanel, Pill, RecordLink, StepUpPrompt, useRecordBridge } from "@erp/ui";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@erp/ui/components/ui/dialog";
import { applyAdvanceAction, openInvoicesAction, runPaymentsStepAction } from "@/lib/payments/actions";
import type { AdvanceApplicationView, AdvanceSection, ApplicationView } from "@/lib/payments/record";
import { useStepRunner } from "@/lib/records/use-step-runner";

// Aplicar anticipo a factura (plan 2B.2 Task 36, owner decisions item 23): the «Anticipos» section of a receipt that holds an advance (what is
// applied and left, its applications each with «Deshacer aplicación», and «Aplicar a facturas»), the read-only record of an application and its
// «Deshacer aplicación» in the record bar (step-up, rule 15). Every button runs a registered process as the session's user (rule 1).

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="erp-sec">
      <h3>
        {title}
        {extra && <> {extra}</>}
      </h3>
      {children}
    </section>
  );
}

/** The dialog of «Deshacer aplicación» (step-up, plan 2B.2 Task 36): names the application and the invoices that are owed again, asks the motivo and the code. */
function UndoDialog({ applicationId, name, invoices, updatedAt, open, onClose, onDone }: { applicationId: string; name: string; updatedAt: string | null; invoices: { number: string; amount: string }[]; open: boolean; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("payments.pages.advance");
  const te = useTranslations("errors");
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const step = useStepRunner(
    (step: string, input, token) => runPaymentsStepAction("payments.advance_application", step, applicationId, input, token),
    () => {
      setReason("");
      onDone();
    },
  );
  const failure = step.failure ? (step.failure.messages.length > 0 ? step.failure.messages.join(" · ") : te.has(step.failure.code) ? te(step.failure.code) : te("unknown")) : null;
  const close = () => {
    if (step.busy) return;
    step.cancel();
    step.clear();
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="erp-dialog">
        <DialogTitle className="erp-dialog__title">{t("undo_dialog.title", { number: name })}</DialogTitle>
        <DialogDescription asChild>
          <div className="erp-dian erp-dian--warn">{t.rich("undo_dialog.explain", { number: name, b: (c) => <b>{c}</b> })}</div>
        </DialogDescription>
        {invoices.length > 0 && (
          <section className="erp-dian" aria-label={t("undo_dialog.invoices")}>
            <b>{t("undo_dialog.invoices")}</b>
            <ul>
              {invoices.map((i, n) => (
                <li key={`${i.number}:${n}`}>
                  <span className="erp-mono">{i.number}</span> · {i.amount}
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="erp-field">
          <label htmlFor={reasonId}>{t("undo_dialog.reason")}</label>
          <input id={reasonId} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="erp-dian erp-dian--info">{t.rich("undo_dialog.step_up", { b: (c) => <b>{c}</b> })}</div>
        {failure && (
          <div role="alert" className="erp-dian erp-dian--bad">
            {failure}
          </div>
        )}
        {step.stepUp && <StepUpPrompt onConfirm={(code) => void step.confirm(code)} onCancel={step.cancel} error={step.stepUpError} busy={step.busy} />}
        <div className="erp-row">
          <span className="erp-grow" />
          <button type="button" className="erp-btn" disabled={step.busy} onClick={close}>
            {t("undo_dialog.cancel")}
          </button>
          <button type="button" className="erp-btn erp-btn--danger" disabled={step.busy || reason.trim() === ""} onClick={() => step.run("undo", { reason, ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}) })}>
            {t("undo_dialog.confirm")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** «Deshacer aplicación» of one application: the button and its dialog. */
function UndoButton({ application, small = false, updatedAt = null }: { application: Pick<AdvanceApplicationView, "id" | "undo">; small?: boolean; updatedAt?: string | null }) {
  const t = useTranslations("payments.pages.advance");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  if (!application.undo) return null;
  return (
    <>
      <button type="button" data-action="undo-application" className={small ? "erp-btn erp-btn--sm erp-btn--danger" : "erp-btn erp-btn--danger erp-touch"} title={t("undo_hint")} onClick={() => setOpen(true)}>
        {t("undo")}
      </button>
      <UndoDialog
        applicationId={application.id}
        name={application.undo.name}
        invoices={application.undo.invoices}
        updatedAt={updatedAt}
        open={open}
        onClose={() => setOpen(false)}
        onDone={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}

/** «Anticipos» of a receipt: the advance, what is applied and left, its applications (each with «Deshacer aplicación») and «Aplicar a facturas». */
export function AdvancesSection({ section, recordId }: { section: AdvanceSection; recordId: string }) {
  const t = useTranslations("payments.pages.advance");
  const router = useRouter();
  const [applying, setApplying] = useState(false);
  return (
    <Section title={t("section")}>
      <div data-testid="advance-section">
        {section.access === "forbidden" ? (
          <p className="erp-small erp-muted">{t("no_access")}</p>
        ) : (
          <>
            <p className="erp-small erp-muted">{t("intro")}</p>
            <dl className="erp-totals">
              <div>
                <dt>{t("advance")}</dt>
                <dd className="erp-num erp-mono">{section.advance}</dd>
              </div>
              <div>
                <dt>{t("applied")}</dt>
                <dd className="erp-num erp-mono" data-testid="advance-applied">
                  {section.applied}
                </dd>
              </div>
              <div>
                <dt>
                  <b>{t("remaining")}</b>
                </dt>
                <dd className="erp-num erp-mono" data-testid="advance-remaining">
                  <b>{section.remaining}</b>
                </dd>
              </div>
            </dl>
            <h4>{t("applications")}</h4>
            {!section.applicationsAvailable ? (
              <p className="erp-small erp-muted" data-testid="advance-applications-unavailable">
                {t("applications_no_access")}
              </p>
            ) : section.applications.length === 0 ? (
              <p className="erp-small erp-muted">{t("applications_none")}</p>
            ) : (
              <div className="erp-lines__scroll">
                <table className="erp-lines__table" aria-label={t("applications")}>
                  <thead>
                    <tr>
                      <th scope="col">{t("application")}</th>
                      <th scope="col">{t("date")}</th>
                      <th scope="col">{t("status")}</th>
                      <th scope="col" className="erp-num">
                        {t("amount")}
                      </th>
                      <th scope="col" />
                    </tr>
                  </thead>
                  <tbody>
                    {section.applications.map((a) => (
                      <tr key={a.id} data-testid="advance-application-row">
                        <td className="erp-mono">{a.linkable ? <RecordLink entity="payments.advance_application" id={a.id} label={a.number} mono /> : a.number}</td>
                        <td className="erp-mono">{a.date}</td>
                        <td>
                          <Pill tone={a.statusTone}>{a.statusLabel}</Pill>
                        </td>
                        <td className="erp-num erp-mono">{a.amount}</td>
                        <td>
                          <UndoButton application={a} small />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {section.canApply && section.partyId && !applying && (
              <div className="erp-row">
                <button type="button" className="erp-btn erp-btn--primary" data-action="apply-advance" onClick={() => setApplying(true)}>
                  {t("apply")}
                </button>
              </div>
            )}
            {applying && section.partyId && (
              <AdvanceApplyPanel
                partyId={section.partyId}
                receiptId={recordId}
                remaining={section.remainingAmount}
                today={section.today}
                invoicesLinkable={section.invoicesLinkable}
                loadInvoices={openInvoicesAction}
                apply={applyAdvanceAction}
                onApplied={() => {
                  setApplying(false);
                  router.refresh();
                }}
                onCancel={() => setApplying(false)}
              />
            )}
          </>
        )}
      </div>
    </Section>
  );
}

/** A stored application of an advance (read only): its facts, the total, which advance receipt paid which invoice, and what the posting did. */
export function ApplicationRecordView({ view }: { view: ApplicationView }) {
  const t = useTranslations("payments.pages.advance");
  const toneClass = view.note === "voided" ? "erp-dian erp-dian--bad" : "erp-dian erp-dian--ok";
  return (
    <div className="erp-form">
      <Section
        title={t("view.facts")}
        extra={
          <span data-testid="application-status">
            <Pill tone={view.statusTone}>{view.statusLabel}</Pill>
          </span>
        }
      >
        <div className="erp-form2">
          {view.facts.map((f) => (
            <div key={f.label} className="erp-field" {...(f.testId ? { "data-testid": f.testId } : {})}>
              <span className="erp-field__label">{f.label}</span>
              {f.link ? <RecordLink entity={f.link.entity} id={f.link.id} label={f.value} /> : <span>{f.value}</span>}
            </div>
          ))}
        </div>
      </Section>
      <Section title={t("view.lines")}>
        <div className="erp-lines__scroll">
          <table className="erp-lines__table" aria-label={t("view.lines")}>
            <thead>
              <tr>
                <th scope="col">{t("view.receipt")}</th>
                <th scope="col">{t("view.invoice")}</th>
                <th scope="col" className="erp-num">
                  {t("view.amount")}
                </th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((l, i) => (
                <tr key={`${l.receiptId}:${l.invoiceId}:${i}`}>
                  <td>{l.receiptLinkable ? <RecordLink entity="payments.receipt" id={l.receiptId} label={l.receiptNumber} mono /> : <span className="erp-mono">{l.receiptNumber}</span>}</td>
                  <td>{l.invoiceLinkable ? <RecordLink entity="invoicing.invoice" id={l.invoiceId} label={l.invoiceNumber} mono /> : <span className="erp-mono">{l.invoiceNumber}</span>}</td>
                  <td className="erp-num erp-mono">{l.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="erp-totals">
          <div>
            <dt>{t("view.total")}</dt>
            <dd className="erp-num erp-mono" data-testid="application-total">
              <b>{view.total}</b>
            </dd>
          </div>
        </dl>
        <div className={toneClass}>{t(`view.note_${view.note}`)}</div>
      </Section>
    </div>
  );
}

/** «Deshacer aplicación» in the record bar of an application (every tab). */
export function ApplicationBarActions({ recordId, view, updatedAt = null }: { recordId: string; view: ApplicationView; updatedAt?: string | null }) {
  const bridge = useRecordBridge();
  if (!view.undo || bridge?.state.dirty) return null;
  return <UndoButton application={{ id: recordId, undo: view.undo }} updatedAt={updatedAt} />;
}

/** `/r/payments.advance_application/new`: an application is made from the receipt that holds the advance. */
export function AdvanceApplicationNew() {
  const t = useTranslations("payments.pages.advance");
  return (
    <div className="erp-form">
      <p className="erp-small" data-testid="advance-application-new">
        {t("new_info")}
      </p>
      <p>
        <a className="erp-btn" href="/payments/receipts">
          {t("go_receipts")}
        </a>
      </p>
    </div>
  );
}
