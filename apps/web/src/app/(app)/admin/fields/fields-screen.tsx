"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import type { FieldsData } from "@/lib/admin/load";
import { StepUpDock, useAdminAction, without } from "../_components/use-admin-action";

const MODES = ["visible", "masked", "hidden"] as const;

/**
 * Field visibility per entity and role (rule 14): visible, masked or hidden, enforced in the masked views and therefore
 * the same in grids, forms, exports and the assistant. Confidential fields are marked; a new role starts with them
 * masked (kernel.seed_role_defaults). The system admin role sees every field.
 */
export function FieldsScreen({ data }: { data: FieldsData }) {
  const t = useTranslations();
  const base = useId();
  const { perform, prompt, status } = useAdminAction();
  const [entityId, setEntityId] = useState(data.entities[0]?.id ?? "");
  const [pending, setPending] = useState<Record<string, string>>({});
  const [shown, setShown] = useState(data);
  if (shown !== data) {
    setShown(data);
    setPending({});
  }
  const entity = data.entities.find((e) => e.id === entityId);
  const roles = data.roles.filter((r) => !r.isSystemAdmin);
  const modeOf = (field: string, roleId: string) => pending[`${entityId}.${field}:${roleId}`] ?? data.modes[`${entityId}.${field}`]?.[roleId] ?? "visible";
  const change = async (field: string, roleId: string, mode: string) => {
    const key = `${entityId}.${field}:${roleId}`;
    setPending((p) => ({ ...p, [key]: mode }));
    if (!(await perform("kernel.admin.field_permission.set", { roleId, entity: entityId, field, mode }))) setPending((current) => without(current, key));
  };
  const label = (key: string, fallback: string) => (t.has(key) ? t(key) : fallback);

  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("common.admin.fields.title")}</h2>
        <div className="erp-field" style={{ minWidth: 220 }}>
          <label htmlFor={`${base}-entity`} className="sr-only">
            {t("common.admin.fields.entity")}
          </label>
          <select id={`${base}-entity`} value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            {data.entities.map((e) => (
              <option key={e.id} value={e.id}>
                {label(e.label, e.id)}
              </option>
            ))}
          </select>
        </div>
        <span className="erp-small erp-muted">{t("common.admin.fields.hint")}</span>
      </div>
      {status && <div style={{ padding: "8px 14px" }}>{status}</div>}
      {entity && (
        <div className="erp-admin__scroll">
          <table className="erp-matrix">
            <thead>
              <tr>
                <th>{t("common.admin.fields.col_field")}</th>
                {roles.map((role) => (
                  <th key={role.id}>{role.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entity.fields.map((field) => (
                <tr key={field.name}>
                  <td>
                    {label(field.label, field.name)} <span className="erp-hint erp-mono erp-small erp-muted">{field.name}</span>{" "}
                    {field.confidential && <span className="erp-pill erp-pill--warn">{t("common.admin.fields.confidential")}</span>}
                  </td>
                  {roles.map((role) => {
                    const mode = modeOf(field.name, role.id);
                    return (
                      <td key={role.id}>
                        <select
                          aria-label={`${role.name} ${label(field.label, field.name)}`}
                          className={mode === "masked" ? "is-masked" : mode === "hidden" ? "is-hidden" : undefined}
                          value={mode}
                          onChange={(e) => void change(field.name, role.id, e.target.value)}
                        >
                          {MODES.map((m) => (
                            <option key={m} value={m}>
                              {t(`common.admin.mode.${m}`)}
                            </option>
                          ))}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="erp-small erp-muted" style={{ padding: "8px 14px" }}>
        {t("common.admin.fields.admin_note")}
      </div>
      <StepUpDock prompt={prompt} />
    </section>
  );
}
