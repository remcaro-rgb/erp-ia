"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useErrorText } from "../forms/form-parts";
import { formatMoney } from "../money/format";
import { recordHref } from "../record/record-model";
import { applyCap, applyInput, applyTotals, setAmount, type ApplyAmounts } from "./advance-apply-model";
import type { LoadOpenInvoices, OpenInvoice } from "./PaymentForms";

// «Aplicar a facturas» on the record page of a receipt that holds an advance (plan 2B.2 Task 36, R36-9): the customer's invoices as «Registrar
// pago» lists them (payments.payment.open_invoices); only the payable ones take an amount, each capped by its open balance and by what is left of
// the advance. «Aplicar anticipo» runs payments.advance.apply once per panel (one idempotency key); the server checks everything again.

export type ApplyOutcome = { ok: true } | { ok: false; code: string; messages: string[] };

export interface AdvanceApplyPanelProps {
  partyId: string;
  /** The receipt that holds the advance. */
  receiptId: string;
  /** What is left of its advance. */
  remaining: number;
  /** The date the open invoices are read for (the application's date: today). */
  today: string;
  /** The caller may open invoices (rule 21). */
  invoicesLinkable?: boolean;
  loadInvoices: LoadOpenInvoices;
  apply: (input: Record<string, unknown>) => Promise<ApplyOutcome>;
  onApplied: () => void;
  onCancel: () => void;
}

export function AdvanceApplyPanel({ partyId, receiptId, remaining, today, invoicesLinkable = false, loadInvoices, apply, onApplied, onCancel }: AdvanceApplyPanelProps) {
  const t = useTranslations("payments.pages.advance");
  const tf = useTranslations("payments.form");
  const errorText = useErrorText();
  const errorTextRef = useRef(errorText);
  useEffect(() => {
    errorTextRef.current = errorText;
  });
  // One «Aplicar anticipo» per panel: a retry (a double click, a lost answer) answers the first application (kernel idempotency).
  const [key] = useState(() => crypto.randomUUID());
  const [invoices, setInvoices] = useState<OpenInvoice[] | null>(null);
  const [amounts, setAmounts] = useState<ApplyAmounts>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadInvoices(partyId, today).then((answer) => {
      if (!live) return;
      if (answer.ok) setInvoices(answer.invoices);
      else {
        setInvoices([]);
        setFailure(answer.messages.length > 0 ? answer.messages.join(" · ") : errorTextRef.current(answer.code));
      }
    });
    return () => {
      live = false;
    };
  }, [partyId, today, loadInvoices]);

  const rows = invoices ?? [];
  const totals = applyTotals(remaining, rows, amounts);
  const input = applyInput(partyId, receiptId, rows, amounts, key, remaining);
  const name = (inv: OpenInvoice) => inv.number ?? inv.id.slice(0, 8);
  const submit = async () => {
    if (!input || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const outcome = await apply(input);
      if (outcome.ok) onApplied();
      else setFailure(outcome.messages.length > 0 ? outcome.messages.join(" · ") : errorText(outcome.code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="erp-sec" aria-label={t("apply_title")} data-testid="advance-apply-panel">
      <h3>{t("apply_title")}</h3>
      <p className="erp-small erp-muted">{t("apply_hint", { remaining: formatMoney(remaining) })}</p>
      {invoices === null ? (
        <p className="erp-small erp-muted" role="status">
          {t("loading")}
        </p>
      ) : rows.length === 0 ? (
        <p className="erp-small erp-muted">{t("none_open")}</p>
      ) : (
        <div className="erp-lines__scroll">
          <table className="erp-lines__table" aria-label={tf("invoices")}>
            <thead>
              <tr>
                <th scope="col">{t("invoice")}</th>
                <th scope="col" className="erp-num">
                  {t("open")}
                </th>
                <th scope="col" className="erp-num">
                  {t("apply_col")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const over = totals.over.includes(inv.id);
                const cap = applyCap(remaining, inv, amounts);
                return (
                  <tr key={inv.id}>
                    <td className="erp-mono">{invoicesLinkable ? <a href={recordHref("invoicing.invoice", inv.id)}>{name(inv)}</a> : name(inv)}</td>
                    <td className="erp-num erp-mono">{formatMoney(inv.open, inv.currency)}</td>
                    {inv.payable ? (
                      <td className="erp-num">
                        <span className="erp-row">
                          <input
                            aria-label={t("apply_to", { invoice: name(inv) })}
                            className={over ? "erp-num erp-mono erp-input--bad" : "erp-num erp-mono"}
                            inputMode="decimal"
                            value={amounts[inv.id] ?? ""}
                            aria-invalid={over ? true : undefined}
                            onChange={(e) => setAmounts((a) => setAmount(a, inv.id, e.target.value))}
                          />
                          <button type="button" className="erp-btn erp-btn--sm" title={t("fill_hint")} disabled={cap <= 0} onClick={() => setAmounts((a) => setAmount(a, inv.id, String(applyCap(remaining, inv, a)).replace(".", ",")))}>
                            {t("fill")}
                          </button>
                        </span>
                        {over && <span className="erp-field__error">{t("over_open", { open: formatMoney(inv.open, inv.currency) })}</span>}
                      </td>
                    ) : (
                      <td className="erp-small">
                        <span className="erp-pill erp-pill--warn">{t("not_payable")}</span> {inv.reason}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <dl className="erp-totals">
        <div>
          <dt>{t("total")}</dt>
          <dd className="erp-num erp-mono" data-testid="advance-apply-total">
            {formatMoney(totals.total)}
          </dd>
        </div>
        <div>
          <dt>{t("left")}</dt>
          <dd className="erp-num erp-mono" data-testid="advance-apply-left">
            {formatMoney(Math.max(totals.left, 0))}
          </dd>
        </div>
      </dl>
      {totals.exceeds && <div className="erp-dian erp-dian--warn">{t("exceeds", { total: formatMoney(totals.total), remaining: formatMoney(remaining) })}</div>}
      {failure && (
        <div role="alert" className="erp-dian erp-dian--bad">
          {failure}
        </div>
      )}
      <div className="erp-row">
        <span className="erp-small erp-muted erp-grow" role="status">
          {busy ? t("applying") : input ? "" : t("missing")}
        </span>
        <button type="button" className="erp-btn" disabled={busy} onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="button" className="erp-btn erp-btn--primary" disabled={!input || busy} onClick={() => void submit()}>
          {t("confirm")}
        </button>
      </div>
    </section>
  );
}
