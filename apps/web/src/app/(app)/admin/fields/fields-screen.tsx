"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import type { FieldsData } from "@/lib/admin/load";
import { StepUpDock } from "../_components/use-admin-action";
import { useStagedChanges } from "../_components/use-staged-changes";

const MODES = ["visible", "masked", "hidden"] as const;

/**
 * Field visibility per entity and role (rule 14): visible, masked or hidden, enforced in the masked views and therefore
 * the same in grids, forms, exports and the assistant. Confidential fields are marked; a new role starts with them
 * masked (kernel.seed_role_defaults). The system admin role sees every field. A change stages the cell; the staged cells
 * (of every entity) are applied together with one step-up through kernel.admin.field_permission.set_many (OD-7).
 */
export function FieldsScreen({ data }: { data: FieldsData }) {
  const t = useTranslations();
  const base = useId();
  const [entityId, setEntityId] = useState(data.entities[0]?.id ?? "");
  const roleIds = new Set(data.roles.filter((r) => !r.isSystemAdmin).map((r) => r.id));
  /** `entity.field:role` → the stored mode (no row: visible). */
  const storedOf = (entity: string, field: string, roleId: string) => data.modes[`${entity}.${field}`]?.[roleId] ?? "visible";
  const parse = (key: string) => {
    const at = key.lastIndexOf(":");
    const path = key.slice(0, at);
    const dot = path.lastIndexOf(".");
    return { entity: path.slice(0, dot), field: path.slice(dot + 1), roleId: key.slice(at + 1) };
  };
  const staged = useStagedChanges<string, { roleId: string; entity: string; field: string; mode: string }>({
    data,
    stored: (key) => {
      const { entity, field, roleId } = parse(key);
      const known = roleIds.has(roleId) && data.entities.some((e) => e.id === entity && e.fields.some((f) => f.name === field));
      return known ? storedOf(entity, field, roleId) : undefined;
    },
    processId: "kernel.admin.field_permission.set_many",
    change: (key, mode) => ({ ...parse(key), mode }),
  });
  const entity = data.entities.find((e) => e.id === entityId);
  const roles = data.roles.filter((r) => !r.isSystemAdmin);
  const keyOf = (field: string, roleId: string) => `${entityId}.${field}:${roleId}`;
  const modeOf = (field: string, roleId: string) => staged.value(keyOf(field, roleId), storedOf(entityId, field, roleId));
  const change = (field: string, roleId: string, mode: string) => staged.set(keyOf(field, roleId), mode, storedOf(entityId, field, roleId));
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
      {entity && (
        <div className="erp-admin__scroll">
          <table className="erp-matrix">
            <thead>
              <tr>
                <th scope="col" className="erp-matrix__left">
                  {t("common.admin.fields.col_field")}
                </th>
                {roles.map((role) => (
                  <th key={role.id} scope="col">
                    {role.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entity.fields.map((field) => (
                <tr key={field.name}>
                  <td className="erp-matrix__left">
                    {label(field.label, field.name)} <span className="erp-hint erp-mono erp-small erp-muted">{field.name}</span>{" "}
                    {field.confidential && <span className="erp-pill erp-pill--warn">{t("common.admin.fields.confidential")}</span>}
                  </td>
                  {roles.map((role) => {
                    const mode = modeOf(field.name, role.id);
                    const key = keyOf(field.name, role.id);
                    const name = `${role.name} ${label(field.label, field.name)}`;
                    const isStaged = staged.isStaged(key);
                    const refusal = staged.refusal(key);
                    return (
                      <td key={role.id} className={refusal ? "is-refused" : isStaged ? "is-dirty" : undefined} title={refusal}>
                        <select
                          aria-label={isStaged ? t("common.admin.pending_cell", { label: name }) : name}
                          aria-invalid={refusal ? true : undefined}
                          className={mode === "masked" ? "is-masked" : mode === "hidden" ? "is-hidden" : undefined}
                          value={mode}
                          disabled={staged.busy}
                          onChange={(e) => change(field.name, role.id, e.target.value)}
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
      {/* One fixed bar under the matrix holds the pending changes and the outcome: nothing above the table ever moves it. */}
      {staged.bar(t("common.admin.fields.admin_note"))}
      <StepUpDock prompt={staged.prompt} />
    </section>
  );
}
