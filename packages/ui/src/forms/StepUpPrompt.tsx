"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

export interface StepUpPromptProps {
  onConfirm: (code: string) => void;
  onCancel: () => void;
  /** Code of the last failed attempt, or null. */
  error: string | null;
  busy?: boolean;
}

/**
 * The inline step-up (rule 15): the process is sensitive, so the save waits for a fresh 6-digit TOTP code. The box takes
 * the caret, the 6th digit (typed or pasted) sends the code, Esc cancels, and a refused code is cleared for the next try.
 */
export function StepUpPrompt({ onConfirm, onCancel, error, busy }: StepUpPromptProps) {
  const t = useTranslations();
  const [code, setCode] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // The code last sent: never sent twice, and cleared when its attempt is refused.
  const sent = useRef<string | null>(null);
  const ready = /^\d{6}$/.test(code) && sent.current !== code;
  const send = (value: string) => {
    if (!/^\d{6}$/.test(value) || busy || sent.current === value) return;
    sent.current = value;
    onConfirm(value);
  };
  useEffect(() => {
    if (!error || busy || sent.current === null) return;
    // The attempt with this code was refused (the error appeared, or the same error came back once the attempt ended).
    sent.current = null;
    setCode("");
    input.current?.focus();
  }, [error, busy]);
  return (
    // data-enter-skip: the code box keeps the native Enter (send); the form's Enter-to-next leaves it alone.
    <div className="erp-stepup" role="group" aria-label={t("process.step_up.title")} data-enter-skip="">
      <b>{t("process.step_up.title")}</b>
      <span className="erp-small">{t("process.step_up.hint")}</span>
      <div className="erp-row">
        <input
          ref={input}
          aria-label={t("common.forms.step_up_code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          // The prompt appears because the user just asked to save: the code is the next thing to type.
          autoFocus
          maxLength={6}
          className="erp-mono"
          value={code}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, "").slice(0, 6);
            setCode(next);
            if (next !== sent.current) sent.current = null;
            send(next);
          }}
          onPaste={(e) => {
            // A code copied with spaces or dashes ("482 193") still fits the 6-digit box.
            const digits = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
            if (!digits) return;
            e.preventDefault();
            setCode(digits);
            send(digits);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready) send(code);
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
        />
        <button type="button" className="erp-btn erp-btn--primary erp-btn--sm" disabled={!ready || busy} onClick={() => send(code)}>
          {t("process.step_up.submit")}
        </button>
        <button type="button" className="erp-btn erp-btn--ghost erp-btn--sm" aria-keyshortcuts="Escape" onClick={onCancel}>
          {t("common.forms.step_up_cancel")}
        </button>
      </div>
      {error && (
        <span role="alert" className="erp-field__error">
          {t("common.forms.step_up_failed")}
        </span>
      )}
    </div>
  );
}
