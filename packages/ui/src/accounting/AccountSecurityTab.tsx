"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { failureMessages } from "../forms/form-parts";
import type { RequestStepUp, SaveRecord } from "../forms/save-model";
import { StepUpPrompt } from "../forms/StepUpPrompt";
import { useSaveFlow } from "../forms/use-save";
import { addGrant, removeGrant, securityChanged, securityInput, setGrant, stepUpFor, type Access, type Grant, type SecurityDraft, type Subject } from "./account-security-model";

// The Seguridad tab of a Cuenta (accounting design §4.15, §5.13, §8): the Abierta / Restringida switch and the grants grid (rol o
// usuario · ver · contabilizar) with Agregar and Quitar. Only the company admin sees it. Every change is `account_permission.update`,
// a step-up process: the save asks for the TOTP code in place, and Quitar saves at once, so it asks for it too.

export interface AccountSecurityTabProps {
  accountId: string;
  /** As `account_permission.consult` answers. */
  stored: SecurityDraft;
  /** `restricted` when a parent's restriction applies although this account is `open` itself; `inheritedFrom` names that parent. */
  effective: Access;
  inheritedFrom: string | null;
  subjects: readonly Subject[];
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  onSaved?: () => void;
}

export function AccountSecurityTab({ accountId, stored, effective, inheritedFrom, subjects, save, requestStepUp, onSaved }: AccountSecurityTabProps) {
  const t = useTranslations("accounting.record.security");
  const te = useTranslations("errors");
  const key = JSON.stringify(stored);
  const [seen, setSeen] = useState(key);
  const [draft, setDraft] = useState<SecurityDraft>(stored);
  const [pick, setPick] = useState("");
  if (seen !== key) {
    setSeen(key);
    setDraft(stored);
  }
  const flow = useSaveFlow(save, requestStepUp, () => onSaved?.());
  const failed = failureMessages(flow.failure, [], (code) => (te.has(code) ? te(code) : te("unknown")));
  const dirty = securityChanged(stored, draft);
  const free = subjects.filter((s) => !draft.grants.some((g) => g.subjectKind === s.kind && g.subjectId === s.id));
  const choose = (access: Access) => setDraft((d) => ({ ...d, access }));
  const submit = (next: SecurityDraft) => void flow.submit(securityInput(accountId, next));
  const subjectLabel = (g: Grant) => g.subjectName ?? g.subjectId;
  const groups = (kind: Subject["kind"]) => free.filter((s) => s.kind === kind);

  return (
    <div className="erp-stack">
      <fieldset className="erp-security__access" role="radiogroup" aria-label={t("access")}>
        <legend className="erp-field__label">{t("access")}</legend>
        {(["open", "restricted"] as const).map((access) => (
          <label key={access} className="erp-row">
            <input type="radio" name="account-access" checked={draft.access === access} onChange={() => choose(access)} />
            <span>{t(access)}</span>
          </label>
        ))}
        <p className="erp-small erp-muted">{t(draft.access === "restricted" ? "restricted_note" : "open_note")}</p>
        {draft.access === "open" && effective === "restricted" && inheritedFrom && <p className="erp-small erp-dian erp-dian--info">{t("inherited", { account: inheritedFrom })}</p>}
      </fieldset>

      {draft.access === "restricted" && (
        <>
          <h3 className="erp-origin__title">{t("grants")}</h3>
          {draft.grants.length === 0 ? (
            <p className="erp-small erp-dian erp-dian--warn">{t("no_grants")}</p>
          ) : (
            <div className="erp-lines__scroll">
              <table className="erp-lines__table" aria-label={t("grants_label")}>
                <thead>
                  <tr>
                    <th scope="col">{t("subject")}</th>
                    <th scope="col">{t("kind")}</th>
                    <th scope="col">{t("view")}</th>
                    <th scope="col">{t("post")}</th>
                    <th scope="col" aria-label={t("actions")} />
                  </tr>
                </thead>
                <tbody>
                  {draft.grants.map((g) => (
                    <tr key={`${g.subjectKind}|${g.subjectId}`}>
                      <td>{subjectLabel(g)}</td>
                      <td className="erp-muted">{t(g.subjectKind)}</td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={t("view_of", { name: subjectLabel(g) })}
                          checked={g.canView}
                          onChange={(e) => setDraft((d) => ({ ...d, grants: setGrant(d.grants, g.subjectKind, g.subjectId, { canView: e.target.checked }) }))}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={t("post_of", { name: subjectLabel(g) })}
                          checked={g.canPost}
                          onChange={(e) => setDraft((d) => ({ ...d, grants: setGrant(d.grants, g.subjectKind, g.subjectId, { canPost: e.target.checked }) }))}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="erp-btn"
                          disabled={flow.saving || flow.stepUp}
                          aria-label={t("remove_of", { name: subjectLabel(g) })}
                          onClick={() => {
                            const next = { ...draft, grants: removeGrant(draft.grants, g.subjectKind, g.subjectId) };
                            setDraft(next);
                            submit(next);
                          }}
                        >
                          {t("remove")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="erp-row">
            <select aria-label={t("pick")} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{t("pick_empty")}</option>
              <optgroup label={t("roles")}>
                {groups("role").map((s) => (
                  <option key={`role|${s.id}`} value={`role|${s.id}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t("users")}>
                {groups("user").map((s) => (
                  <option key={`user|${s.id}`} value={`user|${s.id}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            </select>
            <button
              type="button"
              className="erp-btn"
              disabled={pick === ""}
              onClick={() => {
                const subject = free.find((s) => `${s.kind}|${s.id}` === pick);
                if (!subject) return;
                setDraft((d) => ({ ...d, grants: addGrant(d.grants, subject) }));
                setPick("");
              }}
            >
              {t("add")}
            </button>
          </div>
        </>
      )}

      <div className="erp-form__actions">
        {flow.stepUp && <StepUpPrompt onConfirm={(code) => void flow.confirmStepUp(code)} onCancel={flow.cancelStepUp} error={flow.stepUpError} busy={flow.saving} />}
        {failed.panel.length > 0 && (
          <ul role="alert" className="erp-field__error">
            {failed.panel.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        <div className="erp-row">
          <span className="erp-small erp-muted erp-grow" role="status">
            {flow.saving ? t("saving") : ""} <span className="erp-mono">{stepUpFor("toggle").process}</span>
          </span>
          {dirty && (
            <button type="button" className="erp-btn" disabled={flow.saving} onClick={() => setDraft(stored)}>
              {t("discard")}
            </button>
          )}
          <button type="button" className="erp-btn erp-btn--primary" disabled={!dirty || flow.saving || flow.stepUp} onClick={() => submit(draft)}>
            {t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
