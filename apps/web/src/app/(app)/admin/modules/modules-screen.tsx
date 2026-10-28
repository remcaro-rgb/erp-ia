"use client";

import { useTranslations } from "next-intl";
import type { ModulesData } from "@/lib/admin/load";
import { StepUpDock, useAdminAction } from "../_components/use-admin-action";

/**
 * Módulos (design §5.12, rule 4): one card per module with its state, its menu, what it requires and what needs it.
 * The switch runs kernel.admin.module.enable / disable; a module another active module depends on cannot go off.
 */
export function ModulesScreen({ data }: { data: ModulesData }) {
  const t = useTranslations();
  const { perform, prompt, status, busy } = useAdminAction();
  const name = (id: string) => t(`nav.modules.${id}`);
  return (
    <div className="erp-stack">
      {status}
      <div className="erp-modcards">
        {data.modules.map((module) => (
          <article key={module.id} className="erp-card erp-modcard" style={module.enabled ? undefined : { opacity: 0.8 }}>
            <div className="erp-row">
              <b>{name(module.id)}</b>
              <span className="erp-grow" />
              {!module.purchased ? (
                <span className="erp-pill erp-pill--gray">{t("common.admin.modules.not_purchased")}</span>
              ) : (
                <span className={`erp-pill erp-pill--${module.enabled ? "ok" : "gray"}`}>{module.enabled ? t("common.admin.modules.on") : t("common.admin.modules.off")}</span>
              )}
            </div>
            {t.has(`common.admin.modules.desc.${module.id}`) && <div className="erp-small erp-muted">{t(`common.admin.modules.desc.${module.id}`)}</div>}
            {module.menu.length > 0 && <div className="erp-small">{t("common.admin.modules.menu", { list: module.menu.map((label) => t(label)).join(" · ") })}</div>}
            {module.dependsOn.length > 0 && <div className="erp-small erp-muted">{t("common.admin.modules.requires", { list: module.dependsOn.map(name).join(", ") })}</div>}
            {module.usedBy.length > 0 && <div className="erp-small erp-muted">{t("common.admin.modules.used_by", { list: module.usedBy.map(name).join(", ") })}</div>}
            <div className="erp-row">
              <span className="erp-small erp-muted erp-mono">module:{module.id}</span>
              <span className="erp-grow" />
              <button
                type="button"
                role="switch"
                aria-checked={module.enabled}
                aria-label={name(module.id)}
                disabled={busy || !module.purchased}
                className={`erp-toggle${module.enabled ? " is-on" : ""}`}
                onClick={() => void perform(module.enabled ? "kernel.admin.module.disable" : "kernel.admin.module.enable", { moduleId: module.id })}
              />
            </div>
          </article>
        ))}
      </div>
      <div className="erp-small erp-muted">{t("common.admin.modules.hint")}</div>
      <StepUpDock prompt={prompt} />
    </div>
  );
}
