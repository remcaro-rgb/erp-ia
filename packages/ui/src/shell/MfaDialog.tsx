"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@erp/ui/components/ui/dialog";
import { ENROLL_HREF } from "../forms/StepUpPrompt";

/** The caller's second step as the shell knows it (design §22.19). */
export interface MfaState {
  /** The user has a verified TOTP factor (session claim). */
  enrolled: boolean;
  /** A role of the user requires the second step and they are not exempt: they cannot turn it off. */
  requiredByRole: boolean;
  /** An administrator exempted the user from the admin role's requirement. */
  exempt: boolean;
}

/** The answer of the app's disable run: the process's refusal is data (its code and messages). */
export type MfaDisableResult = { ok: true } | { ok: false; code: string; details: { message: string }[] };

export interface MfaDialogProps extends MfaState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Runs kernel.user.mfa.disable through the app's step-up flow (the process is sensitive: the first run asks for the
   * code, the app shows `stepUpPrompt`, then runs it again with the token). On success the app ends the session.
   */
  onDisable: () => Promise<MfaDisableResult>;
  /** The app's step-up prompt while the run waits for the code: shown inside the dialog (a modal hides the rest). */
  stepUpPrompt?: ReactNode;
  /** Ends the run waiting for the code (the dialog closes meanwhile): the app cancels its step-up, `onDisable` settles. */
  onCancelStepUp?: () => void;
}

/**
 * "Verificación en dos pasos" of the user menu (design §22.19): whether the second step is on; "Desactivar" when it is
 * (a fresh code from that factor first, rule 15), "Activar" (the enrolment page) when it is not. A role that requires it
 * cannot turn it off, and the dialog says who can lift that (an administrator, with an exemption).
 */
export function MfaDialog({ open, onOpenChange, enrolled, requiredByRole, exempt, onDisable, stepUpPrompt, onCancelStepUp }: MfaDialogProps) {
  const t = useTranslations();
  const s = (key: string, values?: Record<string, string>) => t(`nav.shell.mfa.${key}`, values);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const disable = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const result = await onDisable();
      if (result.ok) {
        setOutcome({ ok: true, text: t("auth.notices.mfa_disabled") });
        return;
      }
      // The code was never given (the step-up prompt was cancelled): nothing failed, nothing to say.
      if (result.code === "step_up_required") return;
      const reason = result.details.length > 0 ? result.details.map((d) => d.message).join(" · ") : t.has(`errors.${result.code}`) ? t(`errors.${result.code}`) : t("errors.unknown");
      setOutcome({ ok: false, text: s("failed", { reason }) });
    } finally {
      setBusy(false);
    }
  };

  const close = (next: boolean) => {
    if (!next) {
      setOutcome(null);
      // A run still waiting for the code ends with the dialog (its prompt would otherwise wait unseen).
      if (stepUpPrompt) onCancelStepUp?.();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        showCloseButton={false}
        className="erp-dialog"
        style={{ maxWidth: 480 }}
        // While the step-up prompt is up, Esc belongs to it (it cancels the code, the dialog stays).
        onEscapeKeyDown={(event) => {
          if (stepUpPrompt) event.preventDefault();
        }}
      >
        <div className="erp-dialog__head">
          <DialogTitle className="erp-dialog__title">{s("title")}</DialogTitle>
          <button type="button" className="erp-btn erp-btn--ghost" aria-label={t("common.close")} onClick={() => close(false)}>
            ✕
          </button>
        </div>
        <div className="erp-dialog__body">
          <div className="erp-row">
            <span className="erp-small erp-muted">{s("state")}</span>
            <span className={`erp-pill erp-pill--${enrolled ? "ok" : "warn"}`}>{enrolled ? s("on") : s("off")}</span>
          </div>
          <DialogDescription className="erp-small">{enrolled ? s("on_hint") : s("off_hint")}</DialogDescription>
          {enrolled && !requiredByRole && <p className="erp-small erp-muted">{s("disable_hint")}</p>}
          {requiredByRole && <p className="erp-dian erp-dian--warn">{s("required_by_role")}</p>}
          {exempt && !requiredByRole && <p className="erp-small erp-muted">{s("exempt")}</p>}
          {outcome && (
            <div role={outcome.ok ? "status" : "alert"} className={`erp-dian erp-dian--${outcome.ok ? "ok" : "bad"}`}>
              {outcome.text}
            </div>
          )}
          {stepUpPrompt}
        </div>
        <div className="erp-dialog__foot">
          <button type="button" className="erp-btn" onClick={() => close(false)}>
            {t("common.close")}
          </button>
          {enrolled ? (
            <button type="button" className="erp-btn erp-btn--danger" disabled={busy || requiredByRole || outcome?.ok === true} onClick={() => void disable()}>
              {s("disable")}
            </button>
          ) : (
            <a className="erp-btn erp-btn--primary" href={ENROLL_HREF}>
              {s("enable")}
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
