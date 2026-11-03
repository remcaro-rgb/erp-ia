"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@erp/ui/components/ui/dialog";
import { StepUpPrompt } from "../forms/StepUpPrompt";

// Notificar (entity types spec §7, design §13, approved prototype): the record's PDF by e-mail to the recipients, prefilled from the
// current status's list and editable; sent as Bcc so no recipient sees the others. The subject falls back to the ID while the document
// has no number (D16). The send is the `kernel.record.notify` process (logged in mail_log); a refusal is shown in the dialog.

export interface NotifyDialogProps {
  open: boolean;
  onClose: () => void;
  /** The record's name in the title («Comprobante CE-000123»). */
  name: string;
  recipients: readonly string[];
  subject: string;
  onSend: (mail: { to: string[]; subject: string; message: string }, stepUp?: string) => Promise<{ ok: true; status: string } | { ok: false; code: string; messages: string[] }>;
  requestStepUp?: (code: string) => Promise<{ token: string } | { error: string }>;
  /** Told after a send went out. */
  onSent?: (count: number) => void;
}

const MAX = 50;
const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e);

export function NotifyDialog({ open, onClose, name, recipients, subject: initialSubject, onSend, requestStepUp, onSent }: NotifyDialogProps) {
  const t = useTranslations("common.record.notify_dialog");
  const te = useTranslations("errors");
  const [to, setTo] = useState<string[]>(() => [...recipients]);
  const [text, setText] = useState("");
  const [subject, setSubject] = useState(initialSubject);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const bad = to.filter((e) => !valid(e));
  const blocked = bad.length > 0 || to.length === 0 || to.length > MAX;

  const addTyped = () => {
    const parts = text.split(/[\s,;]+/).filter(Boolean);
    if (parts.length === 0) return;
    setTo((list) => [...list, ...parts.filter((p) => !list.includes(p))]);
    setText("");
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === ";") {
      event.preventDefault();
      addTyped();
    } else if (event.key === "Backspace" && text === "" && to.length > 0) setTo((list) => list.slice(0, -1));
  };
  // Minor 2: one send at a time, whatever React has rendered yet (a double click on Enviar).
  const sending = useRef(false);
  const send = async (token?: string) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await onSend({ to, subject, message }, token);
      if (outcome.ok && outcome.status === "failed") {
        // Logged failed with the provider's answer (mail_log): nothing went out, so the dialog stays open to retry.
        setStepUp(false);
        setProblem(t("failed", { reason: t("provider_failed") }));
      } else if (outcome.ok) {
        setStepUp(false);
        onSent?.(to.length);
        onClose();
      } else if (outcome.code === "step_up_required" && requestStepUp) setStepUp(true);
      else setProblem(t("failed", { reason: outcome.messages.length > 0 ? outcome.messages.join(" · ") : te.has(outcome.code) ? te(outcome.code) : te("unknown") }));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const confirmStepUp = async (code: string) => {
    if (!requestStepUp) return;
    setStepUpError(null);
    const answer = await requestStepUp(code);
    if ("error" in answer) setStepUpError(answer.error);
    else await send(answer.token);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="erp-dialog">
        <DialogTitle className="erp-dialog__title">{t("title", { name })}</DialogTitle>
        <DialogDescription className="erp-small erp-muted">{t("bcc")}</DialogDescription>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="erp-field">
            <label htmlFor="notify-to">
              {t("to")} <span className="erp-muted erp-small">· {t("to_hint", { count: to.length })}</span>
            </label>
            <div className="erp-chips">
              {to.map((email) => (
                <span key={email} className={valid(email) ? "erp-chip" : "erp-chip erp-chip--bad"}>
                  {email}
                  <button type="button" aria-label={t("remove", { email })} onClick={() => setTo((list) => list.filter((e) => e !== email))}>
                    ✕
                  </button>
                </span>
              ))}
              <input id="notify-to" value={text} placeholder={t("placeholder")} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={addTyped} />
            </div>
            {bad.length > 0 && <span className="erp-small erp-text-danger" role="alert">{t("bad", { count: bad.length })}</span>}
            {to.length === 0 && <span className="erp-small erp-muted">{t("none")}</span>}
            {to.length > MAX && <span className="erp-small erp-text-danger">{t("over")}</span>}
          </div>
          <div className="erp-field">
            <label htmlFor="notify-subject">{t("subject")}</label>
            <input id="notify-subject" value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="erp-field">
            <label htmlFor="notify-message">{t("message")}</label>
            <textarea id="notify-message" rows={3} value={message} maxLength={4000} onChange={(e) => setMessage(e.target.value)} />
          </div>
          <p className="erp-small erp-muted">{t("attach")}</p>
          {stepUp && <StepUpPrompt onConfirm={(code) => void confirmStepUp(code)} onCancel={() => setStepUp(false)} error={stepUpError} busy={busy} />}
          {problem && (
            <div role="alert" className="erp-dian erp-dian--bad">
              {problem}
            </div>
          )}
          <div className="erp-row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="erp-btn erp-touch" onClick={onClose}>
              {t("cancel")}
            </button>
            <button type="button" className="erp-btn erp-btn--primary erp-touch" disabled={blocked || busy} onClick={() => void send()}>
              {t("send")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
