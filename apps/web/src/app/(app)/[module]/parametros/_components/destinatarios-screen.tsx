"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { validateEmail } from "@erp/kernel/validation";
import type { DestinatariosData } from "@/lib/parametros/load";
import { StepUpDock, useAdminAction } from "../../../admin/_components/use-admin-action";

/** The states a list can be kept for: never Borrador (nothing is e-mailed for a draft); a maestro has no Contabilizado / Anulado (D6). */
const DOCUMENTO_STATES = ["saved", "pending", "rejected", "approved", "posted", "voided"] as const;
const MAESTRO_STATES = ["saved", "pending", "rejected", "approved"] as const;
const MAX = 50;

/**
 * Destinatarios por estado (spec §7, prototype «destinatarios»): who receives the record's PDF (default template, Bcc) when a record of
 * the entity enters a state. No list, no mail. Guardar runs kernel.state_recipients.update for each changed state (step-up, audited).
 */
export function DestinatariosScreen({ data }: { data: DestinatariosData }) {
  const t = useTranslations();
  const base = useId();
  const { perform, prompt, status, busy } = useAdminAction();
  const [entity, setEntity] = useState(data.entities[0]!.id);
  const [draft, setDraft] = useState(data.lists);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(data);
  if (shown !== data) {
    setShown(data);
    setDraft(data.lists);
  }
  const current = data.entities.find((e) => e.id === entity)!;
  const states = current.type === "maestro" ? MAESTRO_STATES : DOCUMENTO_STATES;
  const listOf = (lists: Record<string, Record<string, string[]>>, s: string) => lists[entity]?.[s] ?? [];
  const changed = states.filter((s) => listOf(draft, s).join("\n") !== listOf(data.lists, s).join("\n"));
  const setList = (s: string, emails: string[]) => setDraft((d) => ({ ...d, [entity]: { ...(d[entity] ?? {}), [s]: emails } }));

  const add = (s: string) => {
    const value = (typed[s] ?? "").trim().toLowerCase();
    if (!value) return;
    const problem = validateEmail(value);
    if (problem) return setError(t("common.parametros.destinatarios.invalid", { email: value, reason: problem }));
    const list = listOf(draft, s);
    if (list.length >= MAX) return setError(t("common.parametros.destinatarios.max", { max: MAX }));
    setError(null);
    if (!list.includes(value)) setList(s, [...list, value]);
    setTyped((v) => ({ ...v, [s]: "" }));
  };
  const save = async () => {
    for (const s of changed) {
      if (!(await perform("kernel.state_recipients.update", { entity, status: s, emails: listOf(draft, s) }))) break;
    }
  };

  return (
    <div className="erp-stack erp-param">
      <div className="erp-row">
        <h1>{t("nav.section.page.state_recipients")}</h1>
        <span className="erp-pill erp-pill--info">{t("nav.section.parametros")}</span>
      </div>
      <p className="erp-muted">{t("common.parametros.destinatarios.intro", { max: MAX })}</p>
      <div className="erp-row">
        <label htmlFor={`${base}-entity`} className="erp-field__label">
          {t("common.parametros.entity")}
        </label>
        <select
          id={`${base}-entity`}
          value={entity}
          disabled={changed.length > 0}
          onChange={(e) => {
            setEntity(e.target.value);
            setError(null);
          }}
        >
          {data.entities.map((e) => (
            <option key={e.id} value={e.id}>
              {t("common.parametros.entity_option", { entity: t(e.label), kind: t(`common.parametros.kind_lower.${e.type}`) })}
            </option>
          ))}
        </select>
        {changed.length > 0 && <span className="erp-small erp-muted">{t("common.parametros.destinatarios.save_first")}</span>}
      </div>
      {error && (
        <div role="alert" className="erp-dian erp-dian--bad">
          {error}
        </div>
      )}
      <section className="erp-card">
        <div className="erp-param__scroll">
          <table className="erp-param__table">
            <thead>
              <tr>
                <th>{t("common.parametros.destinatarios.state")}</th>
                <th>{t("common.parametros.destinatarios.emails")}</th>
                <th className="is-num">{t("common.parametros.destinatarios.count")}</th>
              </tr>
            </thead>
            <tbody>
              {states.map((s) => {
                const label = t(`common.record.status.${s}`);
                const list = listOf(draft, s);
                return (
                  <tr key={s}>
                    <td>
                      <span className="erp-pill erp-pill--gray">{label}</span>
                    </td>
                    <td>
                      <div className="erp-param__emails">
                        {list.map((email) => (
                          <span key={email} className="erp-chip">
                            {email}
                            <button type="button" aria-label={t("common.parametros.destinatarios.remove", { email })} disabled={busy} onClick={() => setList(s, list.filter((x) => x !== email))}>
                              ✕
                            </button>
                          </span>
                        ))}
                        <input
                          aria-label={t("common.parametros.destinatarios.add", { state: label })}
                          placeholder={t("common.parametros.destinatarios.placeholder")}
                          value={typed[s] ?? ""}
                          disabled={busy}
                          onChange={(e) => setTyped((v) => ({ ...v, [s]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === ",") {
                              e.preventDefault();
                              add(s);
                            }
                          }}
                          onBlur={() => add(s)}
                        />
                      </div>
                    </td>
                    <td className="is-num">
                      {list.length} / {MAX}
                    </td>
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
