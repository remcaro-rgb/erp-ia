"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@erp/ui/components/ui/dialog";

/** The answer of the app's change run: the process's refusal is data (its code and messages). */
export type PasswordChangeResult = { ok: true } | { ok: false; code: string; details: { message: string }[] };

export interface PasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs kernel.user.password.change (the current password proves who the user is; no step-up). */
  onChange: (currentPassword: string, newPassword: string) => Promise<PasswordChangeResult>;
}

/** The shortest password the process accepts (kernel.user.password.change); the screen asks before sending. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * "Cambiar contraseña" of the user menu: the current password, the new one twice. The new ones are compared here (a typo
 * would lock the user out of nothing, but costs a round trip); everything else is the process's answer.
 */
export function PasswordDialog({ open, onOpenChange, onChange }: PasswordDialogProps) {
  const t = useTranslations();
  const s = (key: string, values?: Record<string, string>) => t(`nav.shell.password.${key}`, values);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const reset = () => {
    setCurrent("");
    setNext("");
    setAgain("");
    setOutcome(null);
  };
  const close = (value: boolean) => {
    if (!value) reset();
    onOpenChange(value);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== again) {
      setOutcome({ ok: false, text: s("mismatch") });
      return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      const result = await onChange(current, next);
      if (result.ok) {
        setCurrent("");
        setNext("");
        setAgain("");
        setOutcome({ ok: true, text: s("done") });
        return;
      }
      const reason = result.details.length > 0 ? result.details.map((d) => d.message).join(" · ") : t.has(`errors.${result.code}`) ? t(`errors.${result.code}`) : t("errors.unknown");
      setOutcome({ ok: false, text: s("failed", { reason }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={false} className="erp-dialog" style={{ maxWidth: 440 }}>
        <form onSubmit={(event) => void submit(event)}>
          <div className="erp-dialog__head">
            <DialogTitle className="erp-dialog__title">{s("title")}</DialogTitle>
            <button type="button" className="erp-btn erp-btn--ghost" aria-label={t("common.close")} onClick={() => close(false)}>
              ✕
            </button>
          </div>
          <div className="erp-dialog__body">
            <DialogDescription className="erp-small erp-muted">{s("hint")}</DialogDescription>
            <label className="erp-field">
              <span>{s("current")}</span>
              <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
            <label className="erp-field">
              <span>{s("new")}</span>
              <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={72} value={next} onChange={(e) => setNext(e.target.value)} />
            </label>
            <label className="erp-field">
              <span>{s("confirm")}</span>
              <input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
            </label>
            {outcome && (
              <div role={outcome.ok ? "status" : "alert"} className={`erp-dian erp-dian--${outcome.ok ? "ok" : "bad"}`}>
                {outcome.text}
              </div>
            )}
          </div>
          <div className="erp-dialog__foot">
            <button type="button" className="erp-btn" onClick={() => close(false)}>
              {t("common.close")}
            </button>
            <button type="submit" className="erp-btn erp-btn--primary" disabled={busy || current === "" || next === ""}>
              {s("submit")}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
