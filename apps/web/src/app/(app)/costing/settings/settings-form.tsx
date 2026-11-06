"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { StepUpPrompt } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { saveCostingMethodAction } from "@/lib/inventory/actions";

/** The costing method of the company: Promedio ponderado, or PEPS (FIFO), which the process refuses until phase 3. Guardar asks for the code. */
export function CostingSettingsForm({ method, configured, canSave }: { method: string; configured: boolean; canSave: boolean }) {
  const t = useTranslations("costing.settings_page");
  const te = useTranslations("errors");
  const router = useRouter();
  const [value, setValue] = useState(method);
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (token?: string) => {
    setBusy(true);
    try {
      const outcome = await saveCostingMethodAction(value, token);
      if (outcome.ok) {
        setStepUp(false);
        setMessage({ ok: true, text: t("saved") });
        router.refresh();
      } else if (outcome.code === "step_up_required") setStepUp(true);
      else {
        setStepUp(false);
        setMessage({ ok: false, text: outcome.messages.length > 0 ? outcome.messages.join(" · ") : te.has(outcome.code) ? te(outcome.code) : te("unknown") });
      }
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (code: string) => {
    setStepUpError(null);
    const answer = await requestStepUp(code);
    if ("error" in answer) setStepUpError(answer.error);
    else await save(answer.token);
  };
  return (
    <div className="erp-form mx-auto w-full max-w-3xl">
      <section className="erp-sec">
        <h3>{t("title")}</h3>
        <p className="erp-small erp-muted">{configured ? t("configured") : t("default")}</p>
        <div className="erp-form2">
          <div className="erp-field">
            <label htmlFor="costing-method">{t("method")}</label>
            <select id="costing-method" value={value} disabled={!canSave || busy} onChange={(e) => setValue(e.target.value)}>
              <option value="average">{t("average")}</option>
              <option value="fifo">{t("fifo")}</option>
            </select>
          </div>
        </div>
        <p className="erp-small erp-muted">{t("hint")}</p>
      </section>
      {message && (
        <div className={message.ok ? "erp-dian erp-dian--ok" : "erp-dian erp-dian--bad"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </div>
      )}
      {canSave && (
        <div className="erp-form__actions">
          {stepUp && <StepUpPrompt onConfirm={(code) => void confirm(code)} onCancel={() => setStepUp(false)} error={stepUpError} busy={busy} />}
          <div className="erp-row">
            <span className="erp-grow" />
            <button type="button" className="erp-btn erp-btn--primary" disabled={busy || stepUp} onClick={() => void save()}>
              {t("save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
