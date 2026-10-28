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
        <span className="erp-grow" />
        <span className="erp-small erp-muted">{t("common.admin.step_up_note")}</span>
      </div>
      {status && <div style={{ padding: "8px 14px" }}>{status}</div>}
      <div className="erp-admin__scroll">
        <table className="erp-matrix">
          <thead>
            <tr>
              <th>{t("common.admin.permissions.col_entity")}</th>
              <th className="erp-matrix__left">{t("common.admin.permissions.col_process")}</th>
              <th>{t("common.admin.permissions.col_kind")}</th>
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
                  <td colSpan={3 + data.roles.length}>{t(`nav.modules.${moduleId}`)}</td>
                </tr>
                {data.processes
                  .filter((p) => p.module === moduleId)
                  .map((process) => (
                    <tr key={process.id}>
                      <td>
                        <span>{t.has(process.entityLabel) ? t(process.entityLabel) : process.entity}</span>{" "}
                        <span className="erp-hint erp-mono erp-small erp-muted">{process.entity}</span>
                      </td>
                      <td className="erp-matrix__left erp-mono erp-small">
                        {process.id}
                        {process.stepUp && (
                          <span className="erp-pill erp-pill--warn" style={{ marginLeft: 6 }} title={t("common.admin.permissions.step_up_title")}>
                            {t("common.admin.permissions.step_up")}
                          </span>
                        )}
                      </td>
                      <td className="erp-small">{t(`common.admin.kind.${process.kind}`)}</td>
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
      <StepUpDock prompt={prompt} />
    </section>
  );
}
