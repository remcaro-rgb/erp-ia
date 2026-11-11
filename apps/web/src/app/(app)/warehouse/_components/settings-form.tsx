"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { StepUpPrompt } from "@erp/ui";
import { useStepRunner } from "@/lib/records/use-step-runner";
import { saveWarehouseSettingsAction } from "@/lib/warehouse/actions";
import { Failure, useFailureText } from "./failure";

// Parámetros › Configuración de bodega (plan 2B.2 Task 29.4, PG §4.2): two switches saved by warehouse.settings.update (step-up, rule 15).

// -------------------------------------------------------------------------------------------------
// Configuración
// -------------------------------------------------------------------------------------------------

export function WarehouseSettingsForm({ autoPickOnConfirm, deliveryFromPick, canSave }: { autoPickOnConfirm: boolean; deliveryFromPick: boolean; canSave: boolean }) {
  const t = useTranslations("warehouse.settings_page");
  const failureText = useFailureText();
  const router = useRouter();
  const [values, setValues] = useState({ autoPickOnConfirm, deliveryFromPick });
  const [saved, setSaved] = useState(false);
  const step = useStepRunner(
    (_s: "save", input, token) => saveWarehouseSettingsAction(input, token),
    () => (setSaved(true), router.refresh()),
  );
  const changed = values.autoPickOnConfirm !== autoPickOnConfirm || values.deliveryFromPick !== deliveryFromPick;
  const box = (key: keyof typeof values) => (
    <label className="erp-row erp-field">
      <input type="checkbox" checked={values[key]} disabled={!canSave || step.busy} onChange={(e) => (setSaved(false), setValues((v) => ({ ...v, [key]: e.target.checked })))} />
      <span>
        {t(key === "autoPickOnConfirm" ? "auto_pick" : "delivery_from_pick")}
        <span className="erp-field__hint"> {t(key === "autoPickOnConfirm" ? "auto_pick_hint" : "delivery_from_pick_hint")}</span>
      </span>
    </label>
  );
  return (
    <div className="erp-form mx-auto w-full max-w-3xl">
      <section className="erp-sec">
        <h3>{t("title")}</h3>
        <p className="erp-small erp-muted">{t("hint")}</p>
        {box("autoPickOnConfirm")}
        {box("deliveryFromPick")}
      </section>
      <Failure text={failureText(step.failure)} />
      {saved && (
        <div className="erp-dian erp-dian--ok" role="status">
          {t("saved")}
        </div>
      )}
      {canSave && (
        <div className="erp-form__actions">
          {step.stepUp && <StepUpPrompt onConfirm={(code) => void step.confirm(code)} onCancel={step.cancel} error={step.stepUpError} busy={step.busy} />}
          <div className="erp-row">
            <span className="erp-grow" />
            <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy || step.stepUp || !changed} onClick={() => step.run("save", values)}>
              {t("save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

