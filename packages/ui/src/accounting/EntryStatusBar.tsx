"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { StepUpPrompt } from "../forms/StepUpPrompt";
import type { ActionState, EntryAction } from "./entry-model";

// The buttons of a comprobante by its status and the approval flow (accounting design §4.6, §5.5): Enviar a aprobación · Aprobar y
// contabilizar · Devolver a borrador · Contabilizar · Reversar · Anular borrador. The approve button of the person who created the
// comprobante is disabled with the reason in plain sight. Reversing and voiding ask for the motive first.

/** What running an action answers. `step_up_required` makes the bar ask for the code and run it again with the token. */
export type ActionOutcome = { ok: true; message?: string } | { ok: false; code: string; messages: string[] };

export interface EntryStatusBarProps {
  actions: readonly ActionState[];
  /** The caller may run the process behind each action; the others are not shown. */
  can: Readonly<Record<EntryAction, boolean>>;
  /** Runs the action; `stepUp` is the token of a fresh verification, when the process asked for one. */
  onRun: (action: EntryAction, input: { reason?: string }, stepUp?: string) => Promise<ActionOutcome>;
  /** Turns a TOTP code into a step-up token. */
  requestStepUp?: (code: string) => Promise<{ token: string } | { error: string }>;
  disabled?: boolean;
}

const PRIMARY = new Set<EntryAction>(["submit", "approve", "post"]);
const NEEDS_REASON = new Set<EntryAction>(["void", "reverse"]);

export function EntryStatusBar({ actions, can, onRun, requestStepUp, disabled = false }: EntryStatusBarProps) {
  const t = useTranslations("common.entry");
  const te = useTranslations("errors");
  const reasonId = useId();
  const [asking, setAsking] = useState<EntryAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<{ action: EntryAction; reason?: string } | null>(null);
  const [stepUpError, setStepUpError] = useState<string | null>(null);

  const visible = actions.filter((a) => can[a.action]);
  if (visible.length === 0) return null;

  const run = async (action: EntryAction, input: { reason?: string }, token?: string) => {
    setBusy(true);
    setProblems([]);
    setNotice(null);
    try {
      const outcome = await onRun(action, input, token);
      if (outcome.ok) {
        setStepUp(null);
        setAsking(null);
        setReason("");
        setNotice(outcome.message ?? null);
      } else if (outcome.code === "step_up_required" && requestStepUp) {
        setStepUp({ action, ...(input.reason ? { reason: input.reason } : {}) });
      } else {
        setStepUp(null);
        setProblems(outcome.messages.length > 0 ? outcome.messages : [te.has(outcome.code) ? te(outcome.code) : te("unknown")]);
      }
    } finally {
      setBusy(false);
    }
  };

  const click = (action: EntryAction) => {
    if (NEEDS_REASON.has(action)) {
      setAsking(action);
      setProblems([]);
      return;
    }
    void run(action, {});
  };

  const confirmStepUp = async (code: string) => {
    if (!stepUp || !requestStepUp) return;
    setStepUpError(null);
    setBusy(true);
    let answer: Awaited<ReturnType<typeof requestStepUp>>;
    try {
      answer = await requestStepUp(code);
    } finally {
      setBusy(false);
    }
    if ("error" in answer) setStepUpError(answer.error);
    else await run(stepUp.action, stepUp.reason ? { reason: stepUp.reason } : {}, answer.token);
  };

  return (
    <div className="erp-entry-status" role="group" aria-label={t("status")}>
      <div className="erp-row">
        {visible.map(({ action, disabled: off, hint }) => (
          <button
            key={action}
            type="button"
            className={PRIMARY.has(action) ? "erp-btn erp-btn--primary" : action === "void" ? "erp-btn erp-btn--danger" : "erp-btn"}
            disabled={disabled || busy || !!off}
            aria-describedby={off && hint ? `${reasonId}-${action}` : undefined}
            onClick={() => click(action)}
          >
            {t(`actions.${action}`)}
          </button>
        ))}
        {busy && <span className="erp-small erp-muted">{t("acting")}</span>}
      </div>
      {visible
        .filter((a) => a.disabled && a.hint)
        .map((a) => (
          <p key={a.action} id={`${reasonId}-${a.action}`} className="erp-small erp-muted">
            {t(`hint.${a.hint!.split(".").pop()!}`)}
          </p>
        ))}
      {asking && (
        <div className="erp-row erp-entry-status__reason">
          <label htmlFor={reasonId} className="erp-small">
            {t("reason")}
          </label>
          <input id={reasonId} value={reason} maxLength={500} autoFocus onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy || reason.trim() === ""} onClick={() => void run(asking, { reason: reason.trim() })}>
            {t("reason_confirm")}
          </button>
          <button type="button" className="erp-btn" onClick={() => setAsking(null)}>
            {t("reason_cancel")}
          </button>
        </div>
      )}
      {stepUp && <StepUpPrompt onConfirm={(code) => void confirmStepUp(code)} onCancel={() => setStepUp(null)} error={stepUpError} busy={busy} />}
      {problems.length > 0 && (
        <div role="alert" className="erp-dian erp-dian--bad">
          {problems.join(" · ")}
        </div>
      )}
      {notice && (
        <div role="status" className="erp-dian erp-dian--ok">
          {notice}
        </div>
      )}
    </div>
  );
}
