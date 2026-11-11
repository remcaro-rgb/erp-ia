"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { TiposData } from "@/lib/parametros/load";
import { StepUpDock, useAdminAction } from "../../../admin/_components/use-admin-action";

type Flags = { requiresApproval: boolean; posts: boolean };

/**
 * Configuración de tipos (spec §5.4, prototype «tipos»): per maestro and documento of the module, whether a new record needs approval and
 * whether a documento posts. The values are copied onto each record when it is created, so a change here never alters existing records.
 * Guardar runs kernel.entity_type_settings.update for each changed entity (step-up, audited).
 */
export function TiposScreen({ data }: { data: TiposData }) {
  const t = useTranslations();
  const { perform, prompt, status, busy } = useAdminAction();
  const initial = () => Object.fromEntries(data.entities.map((e) => [e.id, { requiresApproval: e.requiresApproval, posts: e.posts }])) as Record<string, Flags>;
  const [draft, setDraft] = useState(initial);
  const [shown, setShown] = useState(data);
  if (shown !== data) {
    setShown(data);
    setDraft(initial());
  }
  const changed = data.entities.filter((e) => draft[e.id]!.requiresApproval !== e.requiresApproval || draft[e.id]!.posts !== e.posts);
  const set = (id: string, patch: Partial<Flags>) => setDraft((d) => ({ ...d, [id]: { ...d[id]!, ...patch } }));
  const save = async () => {
    for (const e of changed) {
      if (!(await perform("kernel.entity_type_settings.update", { entity: e.id, ...draft[e.id]! }))) break;
    }
  };

  return (
    <div className="erp-stack erp-param">
      <div className="erp-row">
        <h1>{t("nav.section.page.entity_types")}</h1>
        <span className="erp-pill erp-pill--info">{t("nav.section.parametros")}</span>
      </div>
      <div className="erp-dian erp-dian--info">
        <b>{t("common.parametros.tipos.copied_title")}</b> {t("common.parametros.tipos.copied_body")}
      </div>
      <section className="erp-card">
        <div className="erp-param__scroll">
          <table className="erp-param__table">
            <thead>
              <tr>
                <th>{t("common.parametros.entity")}</th>
                <th>{t("common.parametros.type")}</th>
                <th className="is-center">{t("common.parametros.tipos.requires_approval")}</th>
                <th className="is-center">{t("common.parametros.tipos.posts")}</th>
                <th>{t("common.parametros.tipos.note")}</th>
              </tr>
            </thead>
            <tbody>
              {data.entities.map((e) => {
                const name = t(e.label);
                const flags = draft[e.id]!;
                const note = [e.ownRequiresApproval && t(e.ownRequiresApproval), e.ownPosts && t(e.ownPosts), e.type === "maestro" && t("common.parametros.tipos.maestro_no_posts")].filter(Boolean).join(" ");
                return (
                  <tr key={e.id}>
                    <td>
                      <b>{name}</b>
                    </td>
                    <td>
                      <span className={`erp-pill ${e.type === "documento" ? "erp-pill--info" : "erp-pill--gray"}`}>{t(`common.parametros.kind.${e.type}`)}</span>
                    </td>
                    <td className="is-center">
                      {e.ownRequiresApproval ? (
                        <span className="erp-small erp-muted">{t("common.parametros.tipos.own")}</span>
                      ) : (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={flags.requiresApproval}
                          aria-label={`${t("common.parametros.tipos.requires_approval")} · ${name}`}
                          className={`erp-toggle${flags.requiresApproval ? " is-on" : ""}`}
                          disabled={busy}
                          onClick={() => set(e.id, { requiresApproval: !flags.requiresApproval })}
                        />
                      )}
                    </td>
                    <td className="is-center">
                      {e.type === "maestro" ? (
                        <span className="erp-muted">—</span>
                      ) : e.ownPosts ? (
                        <span className="erp-small erp-muted">{t("common.parametros.tipos.own")}</span>
                      ) : (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={flags.posts}
                          aria-label={`${t("common.parametros.tipos.posts")} · ${name}`}
                          className={`erp-toggle${flags.posts ? " is-on" : ""}`}
                          disabled={busy}
                          onClick={() => set(e.id, { posts: !flags.posts })}
                        />
                      )}
                    </td>
                    <td className="erp-small erp-muted">{note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <div className="erp-row">
        <span className="erp-grow" />
        <span className="erp-small erp-muted">{changed.length > 0 ? t("common.parametros.unsaved") : t("common.parametros.no_changes")}</span>
        <button type="button" className="erp-btn erp-btn--primary" disabled={busy || changed.length === 0} onClick={() => void save()}>
          {t("common.parametros.save")}
        </button>
      </div>
      {status}
      <StepUpDock prompt={prompt} />
    </div>
  );
}
