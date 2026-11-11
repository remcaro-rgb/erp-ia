"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { StepUpPrompt } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { saveCostingMethodAction, saveUnknownCostModeAction } from "@/lib/inventory/actions";

type Outcome = { ok: true } | { ok: false; code: string; messages: string[] };

/**
 * One saved setting of the screen: its own value, its own step-up dialog and its own message, so changing the method never saves the mode
 * and the reverse. `save` runs the server action with the code once the process asked for it.
 */
function useSetting(save: (value: string, token?: string) => Promise<Outcome>, initial: string) {
  const t = useTranslations("costing.settings_page");
  const te = useTranslations("errors");
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (token?: string) => {
    setBusy(true);
    try {
      const outcome = await save(value, token);
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
    else await run(answer.token);
  };
  return { value, setValue, busy, stepUp, setStepUp, stepUpError, message, run, confirm };
}

function Actions({ s, label }: { s: ReturnType<typeof useSetting>; label: string }) {
  return (
    <>
      {s.message && (
        <div className={s.message.ok ? "erp-dian erp-dian--ok" : "erp-dian erp-dian--bad"} role={s.message.ok ? "status" : "alert"}>
          {s.message.text}
        </div>
      )}
      <div className="erp-form__actions">
        {s.stepUp && <StepUpPrompt onConfirm={(code) => void s.confirm(code)} onCancel={() => s.setStepUp(false)} error={s.stepUpError} busy={s.busy} />}
        <div className="erp-row">
          <span className="erp-grow" />
          <button type="button" className="erp-btn erp-btn--primary" disabled={s.busy || s.stepUp} onClick={() => void s.run()}>
            {label}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The costing settings of the company: the method (Promedio ponderado, or PEPS (FIFO), which the process refuses until phase 3) and what a
 * unit without a known cost is valued at (Cero, or Último costo conocido, Task 44). Each Guardar asks for the code.
 */
export function CostingSettingsForm({
  method, configured, canSave, unknownCostMode, canSaveUnknownCost,
}: { method: string; configured: boolean; canSave: boolean; unknownCostMode: string; canSaveUnknownCost: boolean }) {
  const t = useTranslations("costing.settings_page");
  const methodSetting = useSetting(saveCostingMethodAction, method);
  const modeSetting = useSetting(saveUnknownCostModeAction, unknownCostMode);
  return (
    <div className="erp-form mx-auto w-full max-w-3xl">
      <section className="erp-sec">
        <h3>{t("title")}</h3>
        <p className="erp-small erp-muted">{configured ? t("configured") : t("default")}</p>
        <div className="erp-form2">
          <div className="erp-field">
            <label htmlFor="costing-method">{t("method")}</label>
            <select id="costing-method" value={methodSetting.value} disabled={!canSave || methodSetting.busy} onChange={(e) => methodSetting.setValue(e.target.value)}>
              <option value="average">{t("average")}</option>
              <option value="fifo">{t("fifo")}</option>
            </select>
          </div>
        </div>
        <p className="erp-small erp-muted">{t("hint")}</p>
      </section>
      {canSave && <Actions s={methodSetting} label={t("save")} />}
      <section className="erp-sec">
        <h3>{t("unknown_cost.title")}</h3>
        <div className="erp-form2">
          <div className="erp-field">
            <label htmlFor="costing-unknown-cost">{t("unknown_cost.label")}</label>
            <select
              id="costing-unknown-cost"
              value={modeSetting.value}
              disabled={!canSaveUnknownCost || modeSetting.busy}
              onChange={(e) => modeSetting.setValue(e.target.value)}
            >
              <option value="zero">{t("unknown_cost.zero")}</option>
              <option value="last_known">{t("unknown_cost.last_known")}</option>
            </select>
          </div>
        </div>
        <p className="erp-small erp-muted">{t("unknown_cost.hint")}</p>
        {!canSaveUnknownCost && <p className="erp-small erp-muted">{t("unknown_cost.read_only")}</p>}
      </section>
      {canSaveUnknownCost && <Actions s={modeSetting} label={t("unknown_cost.save")} />}
    </div>
  );
}
