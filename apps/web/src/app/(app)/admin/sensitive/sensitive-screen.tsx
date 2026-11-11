"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { SensitiveData } from "@/lib/admin/load";
import { StepUpDock, useAdminAction, without } from "../_components/use-admin-action";

/**
 * Procesos sensibles (rule 15, owner 2026-11-11): the admin decides, process by process, which ones ask for the step-up in the company,
 * also the ones that ask for it by definition (administration, approvals), and switches every listed process on or off at once from the
 * top row. A process that asks by definition and was switched off says so.
 */
export function SensitiveScreen({ data }: { data: SensitiveData }) {
  const t = useTranslations();
  const { perform, prompt, status, busy } = useAdminAction();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(data);
  if (shown !== data) {
    setShown(data);
    setPending({});
  }
  const isOn = (id: string) => pending[id] ?? data.sensitive.includes(id);
  const toggle = async (id: string, sensitive: boolean) => {
    setPending((p) => ({ ...p, [id]: sensitive }));
    if (!(await perform("kernel.admin.sensitive_process.set", { processId: id, sensitive }))) setPending((current) => without(current, id));
  };
  const ids = data.processes.map((p) => p.id);
  const onCount = ids.filter(isOn).length;
  const allOn = ids.length > 0 && onCount === ids.length;
  const toggleAll = async (sensitive: boolean) => {
    const before = pending;
    setPending(Object.fromEntries(ids.map((id) => [id, sensitive])));
    if (!(await perform("kernel.admin.sensitive_process.set_all", { processIds: ids, sensitive }))) setPending(before);
  };
  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("common.admin.sensitive.title")}</h2>
        <span className="erp-small erp-muted">{t("common.admin.sensitive.hint")}</span>
      </div>
      {status && <div style={{ padding: "8px 14px" }}>{status}</div>}
      {ids.length > 0 && (
        <div className="erp-admin__row" style={{ borderBottom: "1px solid var(--erp-border, #e5e7eb)" }}>
          <div className="erp-grow">
            <strong>{t("common.admin.sensitive.all")}</strong>
          </div>
          <span className="erp-small erp-muted">
            {allOn ? t("common.admin.sensitive.all_on") : onCount === 0 ? t("common.admin.sensitive.all_off") : t("common.admin.sensitive.all_mixed", { on: onCount, total: ids.length })}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={allOn ? true : onCount === 0 ? false : "mixed"}
            aria-label={t("common.admin.sensitive.all")}
            disabled={busy}
            className={`erp-toggle${allOn ? " is-on" : ""}`}
            onClick={() => void toggleAll(!allOn)}
          />
        </div>
      )}
      <div className="erp-admin__scroll">
        {data.processes.map((process) => {
          const on = isOn(process.id);
          const exempted = process.stepUp && !on;
          return (
            <div key={process.id} className="erp-admin__row">
              <div className="erp-grow">
                <div>
                  {t.has(process.entityLabel) ? t(process.entityLabel) : process.entity} · {t(`common.admin.kind.${process.kind}`)}
                </div>
                <div className="erp-mono erp-small erp-muted">{process.id}</div>
                {exempted && <div className="erp-small erp-field__error">{t("common.admin.sensitive.default_off_warning")}</div>}
              </div>
              <span className="erp-small erp-muted">
                {on ? t("common.admin.sensitive.on") : t("common.admin.sensitive.off")}
                {process.stepUp && on ? ` · ${t("common.admin.sensitive.default_on")}` : ""}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={process.id}
                disabled={busy}
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
