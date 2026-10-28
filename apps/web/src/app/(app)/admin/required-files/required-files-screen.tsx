"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { RequiredFile, RequiredFilesData } from "@/lib/admin/load";
import { StepUpDock, useAdminAction, without } from "../_components/use-admin-action";

const KINDS = ["pdf", "image", "any"] as const;
const CONDITIONS = ["", "co", "co-juridica", "proveedor", "cliente"] as const;

type Draft = Omit<RequiredFile, "id"> & { id?: string };

/**
 * Archivos obligatorios (design §5.13): per entity, the tag, the type, whether it is required and when it applies. A
 * required file a record lacks makes it not invoice_ready (§5.17) at once: the row triggers re-evaluate the records.
 */
export function RequiredFilesScreen({ data }: { data: RequiredFilesData }) {
  const t = useTranslations();
  const { perform, prompt, status, busy } = useAdminAction();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [shown, setShown] = useState(data);
  if (shown !== data) {
    setShown(data);
    setDrafts({});
  }
  const rowsOf = (entity: string): (Draft & { key: string })[] => [
    ...data.files.filter((f) => f.entity === entity).map((f) => ({ ...(drafts[f.id] ?? f), key: f.id })),
    ...Object.entries(drafts)
      .filter(([key, d]) => key.startsWith("new:") && d.entity === entity)
      .map(([key, d]) => ({ ...d, key })),
  ];
  const edit = (key: string, base: Draft, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [key]: { ...base, ...(d[key] ?? {}), ...patch } }));
  const save = async (row: Draft & { key: string }) => {
    await perform("kernel.required_file.set", {
      ...(row.id ? { id: row.id } : {}),
      entity: row.entity,
      tag: row.tag,
      kind: row.kind,
      required: row.required,
      condition: row.condition || null,
      description: row.description,
    });
  };
  const remove = async (row: Draft & { key: string }) => {
    if (!row.id) return setDrafts((current) => without(current, row.key));
    if (window.confirm(t("common.admin.required_files.confirm_remove", { tag: row.tag }))) await perform("kernel.required_file.remove", { id: row.id });
  };
  const add = (entity: string) =>
    setDrafts((d) => ({ ...d, [`new:${entity}:${Date.now()}`]: { entity, tag: t("common.admin.required_files.new_tag"), kind: "pdf", required: true, condition: null, description: "" } }));

  return (
    <div className="erp-stack">
      {status}
      {data.entities.map((entity) => (
        <section key={entity.id} className="erp-card">
          <div className="erp-admin__head">
            <h2>{t.has(entity.label) ? t(entity.label) : entity.id}</h2>
            <span className="erp-small erp-muted erp-mono">{entity.id}</span>
            <span className="erp-grow" />
            <button type="button" className="erp-btn erp-btn--sm erp-btn--primary" onClick={() => add(entity.id)}>
              {t("common.admin.required_files.new")}
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>{t("common.admin.required_files.col_tag")}</th>
                <th>{t("common.admin.required_files.col_kind")}</th>
                <th>{t("common.admin.required_files.col_required")}</th>
                <th>{t("common.admin.required_files.col_condition")}</th>
                <th>{t("common.admin.required_files.col_description")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rowsOf(entity.id).length === 0 ? (
                <tr>
                  <td colSpan={6} className="erp-muted">
                    {t("common.admin.required_files.empty")}
                  </td>
                </tr>
              ) : (
                rowsOf(entity.id).map((row) => (
                  <tr key={row.key}>
                    <td>
                      <input aria-label={t("common.admin.required_files.col_tag")} value={row.tag} maxLength={60} onChange={(e) => edit(row.key, row, { tag: e.target.value })} />
                    </td>
                    <td>
                      <select aria-label={`${t("common.admin.required_files.col_kind")} ${row.tag}`} value={row.kind} onChange={(e) => edit(row.key, row, { kind: e.target.value as Draft["kind"] })}>
                        {KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {t(`common.admin.required_files.kind.${kind}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={row.required}
                        aria-label={`${t("common.admin.required_files.col_required")} ${row.tag}`}
                        className={`erp-toggle${row.required ? " is-on" : ""}`}
                        onClick={() => edit(row.key, row, { required: !row.required })}
                      />
                    </td>
                    <td>
                      <select aria-label={`${t("common.admin.required_files.col_condition")} ${row.tag}`} value={row.condition ?? ""} onChange={(e) => edit(row.key, row, { condition: e.target.value || null })}>
                        {CONDITIONS.map((condition) => (
                          <option key={condition} value={condition}>
                            {t(`common.admin.required_files.condition.${condition === "" ? "always" : condition.replace("-", "_")}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ width: "100%" }}>
                      <input
                        aria-label={`${t("common.admin.required_files.col_description")} ${row.tag}`}
                        style={{ width: "100%" }}
                        value={row.description}
                        maxLength={200}
                        onChange={(e) => edit(row.key, row, { description: e.target.value })}
                      />
                    </td>
                    <td>
                      <button type="button" className="erp-btn erp-btn--sm erp-btn--primary" disabled={busy || !(row.key in drafts)} onClick={() => void save(row)}>
                        {t("common.admin.required_files.save")}
                      </button>{" "}
                      <button type="button" className="erp-btn erp-btn--sm erp-btn--ghost" disabled={busy} onClick={() => void remove(row)}>
                        {t("common.admin.required_files.remove")}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      ))}
      <div className="erp-small erp-muted">{t("common.admin.required_files.hint")}</div>
      <StepUpDock prompt={prompt} />
    </div>
  );
}
