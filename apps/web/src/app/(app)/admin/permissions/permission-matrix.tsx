"use client";

import { Fragment } from "react";
import { useTranslations } from "next-intl";
import type { PermissionsData } from "@/lib/admin/load";
import { StepUpDock } from "../_components/use-admin-action";
import { useStagedChanges } from "../_components/use-staged-changes";
import { moduleTarget } from "../_components/staging";

/** The staged cell of `role` × `process`. */
const cellKey = (roleId: string, processId: string) => `${roleId}:${processId}`;

/**
 * Roles as columns, the processes of the company's modules as rows grouped by module, each with the entity it acts on
 * (its name beside the id, design §6). A click stages the cell; the staged cells are applied together with one step-up
 * through kernel.admin.permission.set_many (OD-7). Each module row offers "todos / ninguno" per role. The system admin
 * role holds everything and is not edited here.
 */
export function PermissionMatrix({ data }: { data: PermissionsData }) {
  const t = useTranslations();
  const roleIds = new Set(data.roles.filter((r) => !r.isSystemAdmin).map((r) => r.id));
  const storedOf = (roleId: string, processId: string) => (data.grants[roleId] ?? []).includes(processId);
  const staged = useStagedChanges<boolean, { roleId: string; processId: string; allowed: boolean }>({
    data,
    stored: (key) => {
      const [roleId, processId] = key.split(":") as [string, string];
      return roleIds.has(roleId) && data.processes.some((p) => p.id === processId) ? storedOf(roleId, processId) : undefined;
    },
    processId: "kernel.admin.permission.set_many",
    change: (key, allowed) => {
      const [roleId, processId] = key.split(":") as [string, string];
      return { roleId, processId, allowed };
    },
  });
  const granted = (roleId: string, processId: string) => staged.value(cellKey(roleId, processId), storedOf(roleId, processId));
  const toggle = (roleId: string, processId: string, allowed: boolean) => staged.set(cellKey(roleId, processId), allowed, storedOf(roleId, processId));

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
              <th scope="col" className="erp-matrix__left">
                {t("common.admin.permissions.col_process")}
              </th>
              {data.roles.map((role) => (
                <th key={role.id} scope="col" title={role.isSystemAdmin ? t("common.admin.permissions.admin_locked") : role.description}>
                  {role.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map((moduleId) => {
              const processes = data.processes.filter((p) => p.module === moduleId);
              const moduleName = t(`nav.modules.${moduleId}`);
              return (
                <Fragment key={moduleId}>
                  <tr className="erp-matrix__group">
                    <td className="erp-matrix__left">{moduleName}</td>
                    {data.roles.map((role) => {
                      if (role.isSystemAdmin) return <td key={role.id} />;
                      // Everything given → "ninguno" takes it all back; otherwise "todos" gives every process of the module.
                      const target = moduleTarget(processes.map((p) => granted(role.id, p.id)));
                      return (
                        <td key={role.id}>
                          <button
                            type="button"
                            className="erp-link"
                            disabled={staged.busy}
                            aria-label={t("common.admin.permissions.grant_module", { mode: target ? "all" : "none", role: role.name, module: moduleName })}
                            onClick={() => staged.setAll(processes.map((p) => ({ key: cellKey(role.id, p.id), value: target, stored: storedOf(role.id, p.id) })))}
                          >
                            {target ? t("common.admin.permissions.all") : t("common.admin.permissions.none")}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                  {processes.map((process) => (
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
                      {data.roles.map((role) => {
                        const key = cellKey(role.id, process.id);
                        const label = `${role.name} ${process.id}`;
                        const isStaged = staged.isStaged(key);
                        const refusal = staged.refusal(key);
                        return (
                          <td key={role.id} className={refusal ? "is-refused" : isStaged ? "is-dirty" : undefined}>
                            {/* The whole cell is the target; Space toggles the focused checkbox. */}
                            <label className="erp-matrix__hit" title={refusal}>
                              <input
                                type="checkbox"
                                aria-label={isStaged ? t("common.admin.pending_cell", { label }) : label}
                                aria-invalid={refusal ? true : undefined}
                                checked={role.isSystemAdmin || granted(role.id, process.id)}
                                disabled={role.isSystemAdmin || staged.busy}
                                onChange={(event) => toggle(role.id, process.id, event.target.checked)}
                              />
                            </label>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* One fixed bar under the matrix holds the pending changes and the outcome: nothing above the table ever moves it. */}
      {staged.bar(t("common.admin.no_pending"))}
      <StepUpDock prompt={staged.prompt} />
    </section>
  );
}
