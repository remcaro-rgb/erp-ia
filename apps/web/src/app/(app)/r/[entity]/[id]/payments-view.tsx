"use client";

import { useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { DataGrid, Pill, RecordLink, StepUpPrompt, useRecordBridge } from "@erp/ui";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@erp/ui/components/ui/dialog";
import { runPaymentsStepAction } from "@/lib/payments/actions";
import type { ReceiptView } from "@/lib/payments/record";
import { useStepRunner } from "@/lib/records/use-step-runner";
import { AdvancesSection } from "./advance-view";

// A stored recibo de caja (plan 2B Task 24b, prototype 2B «Recibo de caja RC-0088»). Datos: its state (Contabilizado, Anulado), its facts
// (the customer, the medio de pago and the caja link to their records, rule 21), the money in the money format (rule 23; masked reads
// masked, rule 14), the invoices it paid (links) and what the posting did (the withholdings are a tax in favour; the remainder an advance).
// Asignaciones: what it applied to each invoice in the universal grid (rule 20) and the certificate lines of the withholdings. The bar's
// «Anular recibo» (step-up, rule 15) opens a dialog that says what it undoes: the entry is reversed and the invoices are owed again.

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

export function ReceiptRecordView({ view, recordId }: { view: ReceiptView; recordId: string }) {
  const t = useTranslations("payments.view");
  const toneClass = (tone: string) => (tone === "ok" ? "erp-dian erp-dian--ok" : tone === "danger" ? "erp-dian erp-dian--bad" : tone === "info" ? "erp-dian erp-dian--info" : "erp-dian");
  return (
    <div className="erp-form">
      <Section
        title={t("facts")}
        extra={
          <span data-testid="receipt-status">
            <Pill tone={view.statusTone}>{view.statusLabel}</Pill>
          </span>
        }
      >
        <div className="erp-form2">
          {view.facts.map((f) => (
            <div key={f.label} className="erp-field" {...(f.testId ? { "data-testid": f.testId } : {})}>
              <span className="erp-field__label">{f.label}</span>
              {f.link ? <RecordLink entity={f.link.entity} id={f.link.id} label={f.value} {...(f.mono ? { mono: true } : {})} /> : <span className={f.mono ? "erp-mono" : undefined}>{f.value}</span>}
            </div>
          ))}
          {view.allocations.length > 0 && (
            <div className="erp-field">
              <span className="erp-field__label">{t("invoices")}</span>
              <span className="erp-row">
                {view.allocations.map((a) => (a.linkable ? <RecordLink key={a.invoiceId} entity="invoicing.invoice" id={a.invoiceId} label={a.invoiceNumber} mono /> : <span key={a.invoiceId} className="erp-mono">{a.invoiceNumber}</span>))}
              </span>
            </div>
          )}
        </div>
      </Section>
      <Section title={t("totals")}>
        <dl className="erp-totals">
          <div>
            <dt>{t("amount")}</dt>
            <dd className="erp-num erp-mono" data-testid="receipt-amount">
              <b>{view.totals.amount}</b>
            </dd>
          </div>
          <div>
            <dt>{t("applied")}</dt>
            <dd className="erp-num erp-mono">{view.totals.applied}</dd>
          </div>
          <div>
            <dt>{t("withholdings")}</dt>
            <dd className="erp-num erp-mono">{view.totals.withholdings}</dd>
          </div>
          <div>
            <dt>{t("advance")}</dt>
            <dd className="erp-num erp-mono" data-testid="receipt-advance">
              {view.totals.advance}
            </dd>
          </div>
        </dl>
        {view.notes.map((n) => (
          <div key={n.key} className={toneClass(n.tone)}>
            {t.rich(`note.${n.key}`, { ...n.values, b: (c) => <b>{c}</b> })}
          </div>
        ))}
      </Section>
      {view.advances && <AdvancesSection section={view.advances} recordId={recordId} />}
    </div>
  );
}

/** Asignaciones: the allocations in the universal grid and, under it, the withholdings of the customer's certificates. */
export function ReceiptAllocationsTab({ view }: { view: ReceiptView }) {
  const t = useTranslations("payments.view");
  const held = view.allocations.flatMap((a) => a.withholdings.map((w, i) => ({ ...w, invoice: a, key: `${a.invoiceId}:${i}` })));
  return (
    <div className="erp-form">
      {view.allocationsGrid ? (
        <DataGrid entity={view.allocationsGrid.entity} title={view.allocationsGrid.title} columns={view.allocationsGrid.columns} baseFilters={view.allocationsGrid.filters} initialState={{ sort: [{ field: "line_no", dir: "asc" }] }} />
      ) : (
        <p className="erp-small erp-muted">{t("no_access")}</p>
      )}
      <section className="erp-sec">
        <h3>{t("withholdings_title")}</h3>
        {held.length === 0 ? (
          <p className="erp-small erp-muted">{t("withholdings_none")}</p>
        ) : (
          <div className="erp-lines__scroll">
            <table className="erp-lines__table" aria-label={t("withholdings")}>
              <thead>
                <tr>
                  <th scope="col">{t("w_invoice")}</th>
                  <th scope="col">{t("w_kind")}</th>
                  <th scope="col">{t("w_code")}</th>
                  <th scope="col" className="erp-num">
                    {t("w_rate")}
                  </th>
                  <th scope="col" className="erp-num">
                    {t("w_base")}
                  </th>
                  <th scope="col" className="erp-num">
                    {t("w_amount")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {held.map((w) => (
                  <tr key={w.key}>
                    <td>{w.invoice.linkable ? <RecordLink entity="invoicing.invoice" id={w.invoice.invoiceId} label={w.invoice.invoiceNumber} mono /> : <span className="erp-mono">{w.invoice.invoiceNumber}</span>}</td>
                    <td>{w.kind}</td>
                    <td className="erp-mono">{w.code}</td>
                    <td className="erp-num erp-mono">{w.rate}</td>
                    <td className="erp-num erp-mono">{w.base}</td>
                    <td className="erp-num erp-mono">{w.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** «Anular recibo» in the record bar (every tab): a dialog that names the receipt and the invoices that are owed again, the motivo and the code. */
export function ReceiptBarActions({ recordId, view, updatedAt = null }: { recordId: string; view: ReceiptView; updatedAt?: string | null }) {
  const t = useTranslations("payments.view");
  const te = useTranslations("errors");
  const router = useRouter();
  const bridge = useRecordBridge();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const step = useStepRunner(
    (name: string, input, token) => runPaymentsStepAction("payments.receipt", name, recordId, input, token),
    () => {
      setOpen(false);
      setReason("");
      router.refresh();
    },
  );
  if (!view.void) return null;
  const failure = step.failure ? (step.failure.messages.length > 0 ? step.failure.messages.join(" · ") : te.has(step.failure.code) ? te(step.failure.code) : te("unknown")) : null;
  const close = () => {
    if (step.busy) return;
    step.cancel();
    step.clear();
    setOpen(false);
  };
  return (
    <>
      <button type="button" data-action="void-receipt" className="erp-btn erp-btn--danger erp-touch" disabled={step.busy || (bridge?.state.dirty ?? false)} title={t("void_hint")} onClick={() => (step.clear(), setOpen(true))}>
        {t("void")}
      </button>
      <Dialog open={open} onOpenChange={(next) => !next && close()}>
        <DialogContent className="erp-dialog">
          <DialogTitle className="erp-dialog__title">{t("void_dialog.title", { number: view.void.name })}</DialogTitle>
          <DialogDescription asChild>
            <div className="erp-dian erp-dian--warn">{t.rich("void_dialog.explain", { number: view.void.name, b: (c) => <b>{c}</b> })}</div>
          </DialogDescription>
          {view.void.invoices.length > 0 && (
            <section className="erp-dian" aria-label={t("void_dialog.invoices")}>
              <b>{t("void_dialog.invoices")}</b>
              <ul>
                {view.void.invoices.map((i) => (
                  <li key={i.number}>
                    <span className="erp-mono">{i.number}</span> · {i.amount}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="erp-field">
            <label htmlFor={reasonId}>{t("void_dialog.reason")}</label>
            <input id={reasonId} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
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
            <button type="button" className="erp-btn" disabled={step.busy} onClick={close}>
              {t("void_dialog.cancel")}
            </button>
            <button type="button" className="erp-btn erp-btn--danger" disabled={step.busy || reason.trim() === ""} onClick={() => step.run("void", { reason, ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}) })}>
              {t("void_dialog.confirm")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
