"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { StepUpPrompt } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { overrideRateAction, setRateAction, type RateOutcome } from "@/lib/core/exchange-rate-actions";

/**
 * Registrar tasa (core.exchange_rate.set) and, when the day already holds the TRM, Reemplazar TRM (core.exchange_rate.override_official:
 * a note and the second factor). The rate is typed as raw digits with a comma or a point for the decimals (rule 23: inputs show raw digits).
 */
export function RateForm() {
  const t = useTranslations("core.exchange_rates");
  const te = useTranslations("errors");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState("USD");
  const [rateDate, setRateDate] = useState("");
  const [rate, setRate] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [canOverride, setCanOverride] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const draft = () => ({ currency, rateDate, rate: Number(rate.replace(/\./g, "").replace(",", ".")), note });
  const answer = (outcome: RateOutcome) => {
    if (outcome.ok) {
      setMessage({ ok: true, text: t("saved") });
      setCanOverride(false);
      setStepUp(false);
      router.refresh();
      return;
    }
    if (outcome.code === "step_up_required") return setStepUp(true);
    setStepUp(false);
    if (outcome.reason === "official_rate_exists") setCanOverride(true);
    const known = outcome.reason ? `errors.${outcome.reason}` : null;
    const text = outcome.messages.length > 0 ? outcome.messages.join(" · ") : known && t.has(known) ? t(known) : te.has(outcome.code) ? te(outcome.code) : te("unknown");
    setMessage({ ok: false, text });
  };
  const run = async (action: () => Promise<RateOutcome>) => {
    setBusy(true);
    try {
      answer(await action());
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (code: string) => {
    setStepUpError(null);
    const verified = await requestStepUp(code);
    if ("error" in verified) setStepUpError(verified.error);
    else await run(() => overrideRateAction(draft(), verified.token));
  };

  if (!open) {
    return (
      <button type="button" className="erp-btn" onClick={() => setOpen(true)} data-testid="rate-form-open">
        {t("set")}
      </button>
    );
  }
  return (
    <div className="erp-form" data-testid="rate-form">
      <div className="erp-form2">
        <div className="erp-field">
          <label htmlFor="rate-currency">{t("currency")}</label>
          <input id="rate-currency" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </div>
        <div className="erp-field">
          <label htmlFor="rate-date">{t("date")}</label>
          <input id="rate-date" type="date" value={rateDate} onChange={(e) => setRateDate(e.target.value)} />
        </div>
        <div className="erp-field">
          <label htmlFor="rate-value">{t("rate")}</label>
          <input id="rate-value" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </div>
        <div className="erp-field">
          <label htmlFor="rate-note">{t("note")}</label>
          <input id="rate-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      {message && (
        <div className={message.ok ? "erp-dian erp-dian--ok" : "erp-dian erp-dian--bad"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </div>
      )}
      {canOverride && <p className="erp-small erp-muted">{t("override_hint")}</p>}
      <div className="erp-form__actions">
        {stepUp && <StepUpPrompt onConfirm={(code) => void confirm(code)} onCancel={() => setStepUp(false)} error={stepUpError} busy={busy} />}
        <div className="erp-row">
          <button type="button" className="erp-btn" onClick={() => setOpen(false)} disabled={busy}>
            {t("close")}
          </button>
          <span className="erp-grow" />
          {canOverride && (
            <button type="button" className="erp-btn" disabled={busy || stepUp} onClick={() => void run(() => overrideRateAction(draft()))}>
              {t("override")}
            </button>
          )}
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy || stepUp} onClick={() => void run(() => setRateAction(draft()))}>
            {t("set")}
          </button>
        </div>
      </div>
    </div>
  );
}
