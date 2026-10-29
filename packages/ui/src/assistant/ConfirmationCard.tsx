"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { StepUpField } from "./StepUpField";
import type { CardState, ConfirmationPreview } from "./model";

export interface ConfirmationCardProps {
  /** The process the card runs once confirmed. */
  processId: string;
  preview: ConfirmationPreview;
  /** Pending by default; a decided card keeps its final state in the conversation. */
  state?: CardState;
  /** Confirmar sends `"confirm"` (with the step-up token when the process asks for it); Cancelar `"reject"`. */
  onDecide: (decision: "confirm" | "reject", stepUpToken?: string) => void | Promise<void>;
  /** Editar sends the changed values back to the assistant as a new message; it never runs the process. */
  onEdit?: (text: string) => void | Promise<void>;
  /** `fetch` for the step-up exchange, injected by tests. */
  fetcher?: typeof fetch;
}

/**
 * The assistant's confirmation card (design §7.1, rule 17, prototype v5 `.confirm`): a light-blue header with what is
 * proposed, the effects, the permission it runs under, and Confirmar / Editar / Cancelar. A write never runs from the
 * chat without it; when the process is sensitive the 6-digit code is asked here and Confirmar waits for it.
 */
export function ConfirmationCard({ processId, preview, state = { status: "pending" }, onDecide, onEdit, fetcher }: ConfirmationCardProps) {
  const t = useTranslations();
  const id = useId();
  const [token, setToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(() => preview.effects.map((e) => e.value));
  const confirmRef = useRef<HTMLButtonElement>(null);
  // A verified code makes Confirmar the next step: the caret goes there (Enter confirms).
  useEffect(() => {
    if (token) confirmRef.current?.focus();
  }, [token]);

  const errorText = (code: string) => (t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.unknown"));
  const permission = `${preview.permission} · ${t(preview.stepUp ? "agent.ui.card.with_step_up" : "agent.ui.card.without_step_up")}`;

  if (state.status === "executed" || state.status === "rejected") {
    const done = state.status === "executed";
    const note = done ? t("agent.ui.card.done") : state.reason ? errorText(state.reason) : t("agent.ui.card.rejected");
    return (
      <article className={`erp-confirm ${done ? "erp-confirm--done" : "erp-confirm--rejected"}`} aria-label={preview.title}>
        <div className="erp-confirm__head">
          {done ? "✓ " : "✕ "}
          {preview.title}
        </div>
        <div className="erp-confirm__note">{note}</div>
      </article>
    );
  }

  const busy = state.status === "confirming";
  const needsToken = preview.stepUp && token === null;
  const changes = preview.effects.flatMap((effect, i) => (draft[i] !== undefined && draft[i]!.trim() !== effect.value ? [t("agent.ui.card.change", { field: effect.label, value: draft[i]!.trim() })] : []));

  const confirm = () => {
    const used = token ?? undefined;
    // A step-up token is single use: whatever the outcome, the next attempt asks for a fresh code.
    setToken(null);
    setAttempt((n) => n + 1);
    void onDecide("confirm", used);
  };

  return (
    <article className={`erp-confirm ${preview.stepUp ? "erp-confirm--warn" : ""}`} aria-label={preview.title} data-process={processId}>
      <div className="erp-confirm__head">{preview.title}</div>
      <dl className="erp-confirm__body">
        {preview.effects.map((effect, i) => (
          <div key={i}>
            <dt>{editing ? <label htmlFor={`${id}-${i}`}>{effect.label}</label> : effect.label}</dt>
            <dd>
              {editing ? (
                <input id={`${id}-${i}`} value={draft[i] ?? ""} onChange={(event) => setDraft((d) => d.map((v, j) => (j === i ? event.target.value : v)))} />
              ) : (
                effect.value
              )}
            </dd>
          </div>
        ))}
        <div>
          <dt>{t("agent.ui.card.permission")}</dt>
          <dd>{permission}</dd>
        </div>
      </dl>
      {preview.stepUp && !editing && <StepUpField key={attempt} onToken={setToken} disabled={busy} {...(fetcher ? { fetcher } : {})} />}
      {state.error && (
        <div role="alert" className="erp-confirm__note erp-field__error">
          {errorText(state.error)}
        </div>
      )}
      <div className="erp-confirm__foot">
        {editing ? (
          <>
            <button
              type="button"
              className="erp-btn erp-btn--primary"
              disabled={changes.length === 0}
              onClick={() => {
                setEditing(false);
                void onEdit?.(changes.join(". "));
              }}
            >
              {t("agent.ui.card.send_changes")}
            </button>
            <button type="button" className="erp-btn" onClick={() => setEditing(false)}>
              {t("agent.ui.card.back")}
            </button>
          </>
        ) : (
          <>
            <button ref={confirmRef} type="button" className="erp-btn erp-btn--primary" disabled={busy || needsToken} onClick={confirm}>
              {busy ? t("agent.ui.card.processing") : t("agent.ui.card.confirm")}
            </button>
            <button
              type="button"
              className="erp-btn"
              disabled={busy}
              onClick={() => {
                // The verified code belongs to this proposal: editing it makes a new one, which asks again.
                setToken(null);
                setAttempt((n) => n + 1);
                setEditing(true);
              }}
            >
              {t("agent.ui.card.edit")}
            </button>
            <button type="button" className="erp-btn" disabled={busy} onClick={() => void onDecide("reject")}>
              {t("agent.ui.card.cancel")}
            </button>
          </>
        )}
      </div>
    </article>
  );
}
