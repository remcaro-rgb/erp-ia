"use client";

import { ProcessId } from "@erp/ui";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { CUSTOM_FIELD_TYPES, type CustomFieldType } from "@erp/kernel/custom-fields";
import type { ExtraData } from "@/lib/admin/load";
import { AdminDialog } from "../_components/admin-dialog";
import { StepUpDock, useAdminAction } from "../_components/use-admin-action";

type Entity = ExtraData["entities"][number];
type Field = Entity["customFields"][number];
type Who = "rolesEnter" | "rolesEdit" | "rolesView";

/** A key from a label: lowercase ASCII, digits and underscores (the prototype's rule). */
const keyOf = (label: string) =>
  label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "c_$1")
    .slice(0, 40);

/** Datos adicionales (design §5.14): per entity, the typed fields with their limits and the roles that enter, edit and see them. */
export function ExtraScreen({ data }: { data: ExtraData }) {
  const t = useTranslations();
  const { perform, prompt, status } = useAdminAction();
  // One entity at a time: the first one that already has fields (else the first), chosen from a list instead of every table at once.
  const [chosen, setChosen] = useState<string | null>(null);
  const selectId = useId();
  const current = data.entities.find((e) => e.id === chosen) ?? data.entities.find((e) => e.customFields.length > 0) ?? data.entities[0];
  const [editing, setEditing] = useState<{ entity: Entity; field?: Field } | null>(null);
  const roleName = (id: string) => data.roles.find((r) => r.id === id)?.name ?? id;
  const pills = (ids: readonly string[]) =>
    ids.map((id) => (
      <span key={id} className="erp-pill erp-pill--gray">
        {roleName(id)}
      </span>
    ));
  const remove = (entity: Entity, field: Field) => {
    if (window.confirm(t("common.admin.extra.confirm_remove", { label: field.label }))) void perform("kernel.custom_field.remove", { entity: entity.id, key: field.key });
  };

  return (
    <div className="erp-stack">
      {status}
      <div className="erp-row">
        <label htmlFor={selectId} className="erp-small">
          {t("common.admin.extra.entity")}
        </label>
        <select id={selectId} value={current?.id ?? ""} onChange={(e) => setChosen(e.target.value)}>
          {data.entities.map((entity) => (
            <option key={entity.id} value={entity.id}>
              {(t.has(entity.label) ? t(entity.label) : entity.id) + (entity.customFields.length > 0 ? ` (${entity.customFields.length})` : "")}
            </option>
          ))}
        </select>
      </div>
      {(current ? [current] : []).map((entity) => (
        <section key={entity.id} className="erp-card">
          <div className="erp-admin__head">
            <h2>{t.has(entity.label) ? t(entity.label) : entity.id}</h2>
            <span className="erp-small erp-muted erp-mono">{entity.id}</span>
            <span className="erp-grow" />
            <button type="button" className="erp-btn erp-btn--sm erp-btn--primary" onClick={() => setEditing({ entity })}>
              {t("common.admin.extra.new")}
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>{t("common.admin.extra.col_label")}</th>
                <th>{t("common.admin.extra.col_key")}</th>
                <th>{t("common.admin.extra.col_type")}</th>
                <th className="erp-num">{t("common.admin.extra.col_length")}</th>
                <th>{t("common.admin.extra.col_required")}</th>
                <th>{t("common.admin.extra.col_enter")}</th>
                <th>{t("common.admin.extra.col_edit")}</th>
                <th>{t("common.admin.extra.col_view")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entity.customFields.length === 0 ? (
                <tr>
                  <td colSpan={9} className="erp-muted">
                    {t("common.admin.extra.empty")}
                  </td>
                </tr>
              ) : (
                entity.customFields.map((field) => (
                  <tr key={field.key}>
                    <td>
                      <b>{field.label}</b>
                      {field.options && <div className="erp-small erp-muted">{field.options.join(" · ")}</div>}
                    </td>
                    <td className="erp-mono erp-small">{field.key}</td>
                    <td>{t(`common.extra_data.types.${field.type}`)}</td>
                    <td className="erp-num">{field.maxLength ?? t("common.none")}</td>
                    <td>{field.required ? <span className="erp-pill erp-pill--warn">{t("common.yes")}</span> : <span className="erp-muted">{t("common.no")}</span>}</td>
                    <td style={{ whiteSpace: "normal" }}>{pills(field.rolesEnter)}</td>
                    <td style={{ whiteSpace: "normal" }}>{pills(field.rolesEdit)}</td>
                    <td style={{ whiteSpace: "normal" }}>{pills(field.rolesView)}</td>
                    <td>
                      <button type="button" className="erp-btn erp-btn--sm" onClick={() => setEditing({ entity, field })}>
                        {t("common.admin.extra.edit")}
                      </button>{" "}
                      <button type="button" className="erp-btn erp-btn--sm erp-btn--ghost" onClick={() => remove(entity, field)}>
                        {t("common.admin.extra.remove")}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      ))}
      {editing && <FieldDialog key={`${editing.entity.id}:${editing.field?.key ?? ""}`} data={data} entity={editing.entity} field={editing.field} onClose={() => setEditing(null)} />}
      <StepUpDock prompt={prompt} />
    </div>
  );
}

/** "Nuevo dato adicional" / "Dato adicional · <label>" (kernel.custom_field.set). */
function FieldDialog({ data, entity, field, onClose }: { data: ExtraData; entity: Entity; field?: Field; onClose: () => void }) {
  const t = useTranslations();
  const base = useId();
  const { perform, prompt, status, busy } = useAdminAction();
  const everyone = data.roles.map((r) => r.id);
  const [label, setLabel] = useState(field?.label ?? "");
  const [key, setKey] = useState(field?.key ?? "");
  const [type, setType] = useState<CustomFieldType>(field?.type ?? "text");
  const [maxLength, setMaxLength] = useState(field?.maxLength ? String(field.maxLength) : "");
  const [required, setRequired] = useState(field?.required ?? false);
  const [options, setOptions] = useState((field?.options ?? []).join(" | "));
  const [who, setWho] = useState<Record<Who, string[]>>({
    rolesEnter: [...(field?.rolesEnter ?? everyone)],
    rolesEdit: [...(field?.rolesEdit ?? everyone)],
    rolesView: [...(field?.rolesView ?? everyone)],
  });
  const save = async () => {
    const input = {
      entity: entity.id,
      key,
      label,
      type,
      maxLength: maxLength === "" ? null : Number(maxLength),
      required,
      ...(type === "list" ? { options: options.split("|").map((o) => o.trim()).filter(Boolean) } : {}),
      ...who,
    };
    if (await perform("kernel.custom_field.set", input)) onClose();
  };
  const checks = (what: Who, title: string) => (
    <fieldset className="erp-field">
      <legend className="erp-field__label">{title}</legend>
      <div className="erp-checks">
        {data.roles.map((role) => (
          <label key={role.id} className="erp-check">
            <input
              type="checkbox"
              checked={who[what].includes(role.id)}
              onChange={(e) => setWho((w) => ({ ...w, [what]: e.target.checked ? [...w[what], role.id] : w[what].filter((id) => id !== role.id) }))}
            />{" "}
            {role.name}
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <AdminDialog
      open
      wide
      title={field ? t("common.admin.extra.edit_title", { label: field.label }) : t("common.admin.extra.new_title")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy || label.trim() === "" || key === ""} onClick={() => void save()}>
            {field ? t("common.admin.extra.save") : t("common.admin.extra.create")}
          </button>
        </>
      }
    >
      <div className="erp-form3">
        <div className="erp-field">
          <label htmlFor={`${base}-label`}>{t("common.admin.extra.label")}</label>
          <input
            id={`${base}-label`}
            value={label}
            maxLength={100}
            onChange={(e) => {
              setLabel(e.target.value);
              if (!field) setKey(keyOf(e.target.value));
            }}
          />
        </div>
        <div className="erp-field">
          <label htmlFor={`${base}-key`}>
            {t("common.admin.extra.key")} <span className="erp-field__hint">{t("common.admin.extra.key_hint")}</span>
          </label>
          <input id={`${base}-key`} className="erp-mono" value={key} disabled={Boolean(field)} onChange={(e) => setKey(e.target.value)} />
        </div>
        <div className="erp-field">
          <label htmlFor={`${base}-type`}>{t("common.admin.extra.type")}</label>
          <select id={`${base}-type`} value={type} onChange={(e) => setType(e.target.value as CustomFieldType)}>
            {CUSTOM_FIELD_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`common.extra_data.types.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="erp-field">
          <label htmlFor={`${base}-length`}>{t("common.admin.extra.max_length")}</label>
          <input id={`${base}-length`} type="number" min={1} max={1000} value={maxLength} onChange={(e) => setMaxLength(e.target.value)} />
        </div>
        <label className="erp-check erp-span2">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> {t("common.admin.extra.required_label")}
        </label>
        {type === "list" && (
          <div className="erp-field erp-span3">
            <label htmlFor={`${base}-options`}>
              {t("common.admin.extra.options")} <span className="erp-field__hint">{t("common.admin.extra.options_hint")}</span>
            </label>
            <input id={`${base}-options`} value={options} onChange={(e) => setOptions(e.target.value)} />
          </div>
        )}
      </div>
      <div className="erp-form3">
        {checks("rolesEnter", t("common.admin.extra.col_enter"))}
        {checks("rolesEdit", t("common.admin.extra.col_edit"))}
        {checks("rolesView", t("common.admin.extra.col_view"))}
      </div>
      <div className="erp-small erp-muted"><ProcessId id={"kernel.custom_field.set"} /></div>
      {status}
      {prompt}
    </AdminDialog>
  );
}
