"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { SensitiveData } from "@/lib/admin/load";
import { StepUpDock, useAdminAction, without } from "../_components/use-admin-action";

/**
 * Procesos sensibles (rule 15): the admin raises any process to require the step-up; the administration processes ask
 * for it by definition and stay on.
 */
export function SensitiveScreen({ data }: { data: SensitiveData }) {
  const t = useTranslations();
  const { perform, prompt, status } = useAdminAction();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(data);
  if (shown !== data) {
    setShown(data);
    setPending({});
  }
  const isOn = (id: string, stepUp: boolean) => stepUp || (pending[id] ?? data.sensitive.includes(id));
  const toggle = async (id: string, sensitive: boolean) => {
    setPending((p) => ({ ...p, [id]: sensitive }));
    if (!(await perform("kernel.admin.sensitive_process.set", { processId: id, sensitive }))) setPending((current) => without(current, id));
  };
  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("common.admin.sensitive.title")}</h2>
        <span className="erp-small erp-muted">{t("common.admin.sensitive.hint")}</span>
      </div>
      {status && <div style={{ padding: "8px 14px" }}>{status}</div>}
      <div className="erp-admin__scroll">
        {data.processes.map((process) => {
          const on = isOn(process.id, process.stepUp);
          return (
            <div key={process.id} className="erp-admin__row">
              <div className="erp-grow">
                <div>
                  {t.has(process.entityLabel) ? t(process.entityLabel) : process.entity} · {t(`common.admin.kind.${process.kind}`)}
                </div>
                <div className="erp-mono erp-small erp-muted">{process.id}</div>
              </div>
              <span className="erp-small erp-muted">{process.stepUp ? t("common.admin.sensitive.locked") : on ? t("common.admin.sensitive.on") : t("common.admin.sensitive.off")}</span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={process.id}
                disabled={process.stepUp}
                className={`erp-toggle${on ? " is-on" : ""}`}
                onClick={() => void toggle(process.id, !on)}
              />
            </div>
          );
        })}
      </div>
      <StepUpDock prompt={prompt} />
    </section>
  );
}
