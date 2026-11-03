"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { StepUpPrompt } from "../forms/StepUpPrompt";

// Acceso of a maestro or documento (entity types spec §6, approved prototype; admins only): the record's rules by role or user. Rules
// only narrow, never widen, and never apply to administrators; the database and the processes enforce them, not this screen.
// Saving replaces the rule set through `kernel.record_access.set` (audited, step-up).

export type AccessRight = "read" | "use" | "modify" | "delete" | "void";

export interface AccessOption {
  kind: "role" | "user";
  id: string;
  name: string;
}

export interface AccessGrant extends AccessOption {
  rights: readonly string[];
}

export interface AccessTabProps {
  entityType: "maestro" | "documento";
  grants: readonly AccessGrant[];
  options: readonly AccessOption[];
  /** Saves the rules; `stepUp` is the token of a fresh verification. */
  onSave: (grants: { roleId?: string; userId?: string; rights: string[] }[], stepUp?: string) => Promise<{ ok: true } | { ok: false; code: string; messages: string[] }>;
  requestStepUp?: (code: string) => Promise<{ token: string } | { error: string }>;
}

const RIGHTS: Record<"maestro" | "documento", readonly AccessRight[]> = { maestro: ["read", "use", "modify", "delete"], documento: ["read", "modify", "void"] };

export function AccessTab({ entityType, grants: stored, options, onSave, requestStepUp }: AccessTabProps) {
  const t = useTranslations("common.record.access");
  const te = useTranslations("errors");
  const [grants, setGrants] = useState<AccessGrant[]>(() => stored.map((g) => ({ ...g, rights: [...g.rights] })));
  const [saved, setSaved] = useState(true);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const rights = RIGHTS[entityType];
  const free = options.filter((o) => !grants.some((g) => g.kind === o.kind && g.id === o.id));

  const change = (next: AccessGrant[]) => {
    setGrants(next);
    setSaved(false);
  };
  const toggle = (index: number, right: AccessRight, on: boolean) =>
    change(
      grants.map((g, i) => {
        if (i !== index) return g;
        // Every right needs read (0044): ticking one ticks Ver, unticking Ver unticks the rest.
        const set = new Set(g.rights);
        if (on) set.add(right).add("read");
        else if (right === "read") set.clear();
        else set.delete(right);
        return { ...g, rights: [...set] };
      }),
    );
  const add = () => {
    const option = free.find((o) => `${o.kind}:${o.id}` === pick);
    if (!option) return;
    change([...grants, { ...option, rights: ["read"] }]);
    setPick("");
  };
  const save = async (token?: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await onSave(
        grants.filter((g) => g.rights.length > 0).map((g) => ({ ...(g.kind === "role" ? { roleId: g.id } : { userId: g.id }), rights: [...g.rights] })),
        token,
      );
      if (outcome.ok) {
        setSaved(true);
        setStepUp(false);
      } else if (outcome.code === "step_up_required" && requestStepUp) setStepUp(true);
      else setProblem(outcome.messages.length > 0 ? outcome.messages.join(" · ") : te.has(outcome.code) ? te(outcome.code) : te("unknown"));
    } finally {
      setBusy(false);
    }
  };
  const confirmStepUp = async (code: string) => {
    if (!requestStepUp) return;
    setStepUpError(null);
    const answer = await requestStepUp(code);
    if ("error" in answer) setStepUpError(answer.error);
    else await save(answer.token);
  };

  return (
    <div className="erp-access" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="erp-dian erp-dian--info erp-small">{t("intro")}</div>
      {grants.length === 0 ? (
        <p className="erp-muted">{t("empty")}</p>
      ) : (
        <div className="erp-lines__scroll">
          <table className="erp-lines__table" aria-label={t("grantee")}>
            <thead>
              <tr>
                <th scope="col">{t("grantee")}</th>
                {rights.map((r) => (
                  <th key={r} scope="col">
                    {t(`rights.${r}`)}
                  </th>
                ))}
                <th scope="col" aria-label={t("remove")} />
              </tr>
            </thead>
            <tbody>
              {grants.map((g, index) => (
                <tr key={`${g.kind}:${g.id}`}>
                  <td>
                    {g.name} <span className="erp-muted erp-small">· {t(g.kind)}</span>
                  </td>
                  {rights.map((r) => (
                    <td key={r}>
                      <input type="checkbox" className="erp-touch" aria-label={`${t(`rights.${r}`)} · ${g.name}`} checked={g.rights.includes(r)} onChange={(e) => toggle(index, r, e.target.checked)} />
                    </td>
                  ))}
                  <td>
                    <button type="button" className="erp-btn erp-btn--sm erp-touch" onClick={() => change(grants.filter((_, i) => i !== index))}>
                      {t("remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="erp-row" style={{ flexWrap: "wrap", gap: 8 }}>
        <select aria-label={t("grantee")} value={pick} onChange={(e) => setPick(e.target.value)} className="erp-touch">
          <option value="">{t("grantee")}</option>
          {(["role", "user"] as const).map((kind) => (
            <optgroup key={kind} label={t(kind === "role" ? "roles" : "users")}>
              {free
                .filter((o) => o.kind === kind)
                .map((o) => (
                  <option key={o.id} value={`${o.kind}:${o.id}`}>
                    {o.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <button type="button" className="erp-btn erp-touch" disabled={!pick} onClick={add}>
          {t("add")}
        </button>
        <span className="erp-grow" />
        <span className="erp-small erp-muted" role="status">
          {saved ? t("saved") : t("unsaved")}
        </span>
        <button type="button" className="erp-btn erp-btn--primary erp-touch" disabled={saved || busy} onClick={() => void save()}>
          {t("save")}
        </button>
      </div>
      {stepUp && <StepUpPrompt onConfirm={(code) => void confirmStepUp(code)} onCancel={() => setStepUp(false)} error={stepUpError} busy={busy} />}
      {problem && (
        <div role="alert" className="erp-dian erp-dian--bad">
          {problem}
        </div>
      )}
    </div>
  );
}
