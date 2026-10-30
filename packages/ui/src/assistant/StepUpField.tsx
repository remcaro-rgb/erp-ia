"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ENROLL_HREF } from "../forms/StepUpPrompt";

export interface StepUpFieldProps {
  /** The one-time token once the code is verified; `null` when the code changes or the attempt fails. */
  onToken: (token: string | null) => void;
  /** `fetch`, injected by tests. */
  fetcher?: typeof fetch;
  endpoint?: string;
  disabled?: boolean;
}

const FAILURES: Record<string, string> = { invalid_code: "invalid_code", too_many_attempts: "too_many_attempts", no_factor: "no_factor" };

/**
 * The step-up code in the chat (rule 15, prototype v5): a sensitive process asks for the 6-digit TOTP code inside its
 * card. The code is exchanged at POST /api/auth/step-up for a one-time token (bound to the user, 5 minutes) that the
 * card sends with its confirmation; the card's Confirmar stays disabled until there is one.
 */
export function StepUpField({ onToken, fetcher, endpoint = "/api/auth/step-up", disabled }: StepUpFieldProps) {
  const t = useTranslations();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ready = /^\d{6}$/.test(code);
  const input = useRef<HTMLInputElement>(null);
  // The card asks for the code: take the caret, unless the user is typing somewhere else (never steal it from a form).
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active.id === "erp-assistant-input") input.current?.focus();
  }, []);

  const verify = async (value = code) => {
    if (!/^\d{6}$/.test(value) || busy || verified) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await (fetcher ?? fetch)(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: value }) });
      const body = (await response.json().catch(() => null)) as { token?: unknown; code?: string } | null;
      if (response.ok && typeof body?.token === "string") {
        setVerified(true);
        onToken(body.token);
      } else {
        setFailure(FAILURES[body?.code ?? ""] ?? "failed");
        onToken(null);
      }
    } catch {
      setFailure("failed");
      onToken(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="erp-confirm__stepup" role="group" aria-label={t("process.step_up.title")}>
      <span className="erp-small erp-muted">{t("process.step_up.hint")}</span>
      <div className="erp-row">
        <input
          ref={input}
          aria-label={t("agent.step_up_code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          className="erp-mono"
          value={code}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value.replace(/\D/g, "").slice(0, 6);
            setCode(next);
            if (verified) {
              setVerified(false);
              onToken(null);
            }
            // The 6th digit verifies, typed or pasted: no extra key.
            if (next.length === 6 && !verified) void verify(next);
          }}
          onPaste={(event) => {
            // A code copied with spaces or dashes ("482 193") still fits the 6-digit box, and verifies.
            const digits = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
            if (!digits) return;
            event.preventDefault();
            setCode(digits);
            if (verified) {
              setVerified(false);
              onToken(null);
            }
            if (digits.length === 6) void verify(digits);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void verify();
          }}
        />
        <button type="button" className="erp-btn erp-btn--sm" disabled={!ready || busy || verified || disabled} onClick={() => void verify()}>
          {t("agent.ui.stepup.verify")}
        </button>
        {verified && <span className="erp-pill erp-pill--ok">{t("agent.ui.stepup.verified")}</span>}
      </div>
      {failure && (
        <span role="alert" className="erp-field__error">
          {t(`agent.ui.stepup.${failure}`)}
          {/* No second step (design §22.19): the way to turn it on. */}
          {failure === "no_factor" && (
            <>
              {" "}
              <a className="erp-link erp-link--inline" href={ENROLL_HREF}>
                {t("process.step_up.enroll")}
              </a>
            </>
          )}
        </span>
      )}
    </div>
  );
}
