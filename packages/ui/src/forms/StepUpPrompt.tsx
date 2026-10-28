"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

export interface StepUpPromptProps {
  onConfirm: (code: string) => void;
  onCancel: () => void;
  /** Code of the last failed attempt, or null. */
  error: string | null;
  busy?: boolean;
}

/** The inline step-up (rule 15): the process is sensitive, so the save waits for a fresh 6-digit TOTP code. */
export function StepUpPrompt({ onConfirm, onCancel, error, busy }: StepUpPromptProps) {
  const t = useTranslations();
  const [code, setCode] = useState("");
  const ready = /^\d{6}$/.test(code);
  return (
    <div className="erp-stepup" role="group" aria-label={t("process.step_up.title")}>
      <b>{t("process.step_up.title")}</b>
      <span className="erp-small">{t("process.step_up.hint")}</span>
      <div className="erp-row">
        <input
          aria-label={t("common.forms.step_up_code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          className="erp-mono"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && ready && onConfirm(code)}
        />
        <button type="button" className="erp-btn erp-btn--primary erp-btn--sm" disabled={!ready || busy} onClick={() => onConfirm(code)}>
          {t("process.step_up.submit")}
        </button>
        <button type="button" className="erp-btn erp-btn--ghost erp-btn--sm" onClick={onCancel}>
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
