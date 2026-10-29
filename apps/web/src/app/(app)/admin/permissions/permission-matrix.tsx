"use client";

import { Fragment, useState } from "react";
import { useTranslations } from "next-intl";
import type { PermissionsData } from "@/lib/admin/load";
import { StepUpDock, useAdminAction, without } from "../_components/use-admin-action";

/**
 * Roles as columns, the processes of the company's modules as rows grouped by module, each with the entity it acts on
 * (its name beside the id, design §6). A checkbox grants or revokes through kernel.admin.permission.set; the system
 * admin role holds everything and is not edited here.
 */
export function PermissionMatrix({ data }: { data: PermissionsData }) {
  const t = useTranslations();
  const { perform, prompt, status } = useAdminAction();
  // What the admin just clicked, shown until the server data says the same (or the change is refused).
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(data);
  if (shown !== data) {
    setShown(data);
    setPending({});
  }

  const granted = (roleId: string, processId: string) => {
    const key = `${roleId}:${processId}`;
    return key in pending ? pending[key]! : (data.grants[roleId] ?? []).includes(processId);
  };
  const toggle = async (roleId: string, processId: string, allowed: boolean) => {
    const key = `${roleId}:${processId}`;
    setPending((p) => ({ ...p, [key]: allowed }));
    const ok = await perform("kernel.admin.permission.set", { roleId, processId, allowed });
    if (!ok) setPending((current) => without(current, key));
  };

  const modules = [...new Set(data.processes.map((p) => p.module))];
  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("common.admin.permissions.title")}</h2>
        <span className="erp-small erp-muted">{t("common.admin.permissions.hint")}</span>
      </div>
      <div className="erp-admin__scroll">
        <table className="erp-matrix">
          <thead>
            <tr>
              {/* One identity column, sticky: the process, its kind and its entity stay in view while the roles scroll. */}
              <th className="erp-matrix__left">{t("common.admin.permissions.col_process")}</th>
              {data.roles.map((role) => (
                <th key={role.id} title={role.isSystemAdmin ? t("common.admin.permissions.admin_locked") : role.description}>
                  {role.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map((moduleId) => (
              <Fragment key={moduleId}>
                <tr className="erp-matrix__group">
                  <td className="erp-matrix__left">{t(`nav.modules.${moduleId}`)}</td>
                  <td colSpan={data.roles.length} />
                </tr>
                {data.processes
                  .filter((p) => p.module === moduleId)
                  .map((process) => (
                    <tr key={process.id}>
                      <td className="erp-matrix__left">
                        <span className="erp-mono erp-small">{process.id}</span>{" "}
                        <span className="erp-pill erp-pill--gray" title={t("common.admin.permissions.col_kind")}>
                          {t(`common.admin.kind.${process.kind}`)}
                        </span>
                        {process.stepUp && (
                          <span className="erp-pill erp-pill--warn" title={t("common.admin.permissions.step_up_title")}>
                            {t("common.admin.permissions.step_up")}
                          </span>
                        )}
                        <div className="erp-small erp-muted" title={t("common.admin.permissions.col_entity")}>
                          <span>{t.has(process.entityLabel) ? t(process.entityLabel) : process.entity}</span>{" "}
                          <span className="erp-hint erp-mono">{process.entity}</span>
                        </div>
                      </td>
                      {data.roles.map((role) => (
                        <td key={role.id}>
                          <input
                            type="checkbox"
                            aria-label={`${role.name} ${process.id}`}
                            checked={role.isSystemAdmin || granted(role.id, process.id)}
                            disabled={role.isSystemAdmin}
                            onChange={(event) => void toggle(role.id, process.id, event.target.checked)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {/* One fixed bar under the matrix holds the outcome of the last change: nothing above the table ever moves it. */}
      <div className="erp-admin__bar">{status ?? <span className="erp-small erp-muted">{t("common.admin.step_up_note")}</span>}</div>
      <StepUpDock prompt={prompt} />
    </section>
  );
}
