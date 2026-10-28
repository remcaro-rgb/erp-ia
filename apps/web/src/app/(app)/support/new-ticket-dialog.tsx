"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@erp/ui/components/ui/dialog";
import { captureContext } from "@/lib/support/capture";
import type { CapturedContext } from "@/lib/support/capture-model";
import { createTicketAction } from "@/lib/support/actions";

const KINDS = ["bug", "question", "request"] as const;

export interface NewTicketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the id of the ticket just filed. */
  onCreated: (id: string) => void;
}

/** "Nuevo ticket": kind, title and description, with the screen context the shell captured shown and removable. */
export function NewTicketDialog(props: NewTicketDialogProps) {
  const t = useTranslations();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent showCloseButton={false} className="erp-dialog" aria-describedby={undefined}>
        <div className="erp-dialog__head">
          <DialogTitle className="erp-dialog__title">{t("common.support.ui.new_title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("common.support.ui.context_hint")}</DialogDescription>
          <button type="button" className="erp-btn erp-btn--ghost" aria-label={t("common.close")} onClick={() => props.onOpenChange(false)}>
            ✕
          </button>
        </div>
        {props.open && <NewTicketForm {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function NewTicketForm({ onOpenChange, onCreated }: NewTicketDialogProps) {
  const t = useTranslations();
  const pathname = usePathname();
  const base = useId();
  // Captured when the form opens: what the user selected and the errors seen so far describe the screen before it.
  const [context] = useState<CapturedContext>(() => captureContext(pathname));
  const [kind, setKind] = useState<(typeof KINDS)[number]>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const result = await createTicketAction({ kind, title, body, ...(attach ? { context } : {}) });
      if (result.ok) {
        onOpenChange(false);
        onCreated(result.id);
        return;
      }
      setProblem(result.details.length > 0 ? result.details.join(" · ") : t.has(`errors.${result.code}`) ? t(`errors.${result.code}`) : t("errors.unknown"));
    } catch {
      setProblem(t("errors.network"));
    } finally {
      setBusy(false);
    }
  };

  const hasContext = context.route !== "" || context.selection !== "" || context.consoleErrors.length > 0;
  return (
    <form onSubmit={submit} className="erp-dialog__body">
      <div className="erp-field">
        <label htmlFor={`${base}-kind`}>{t("common.support.ui.kind")}</label>
        <select id={`${base}-kind`} value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`grid.values.ticket_kind.${k}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="erp-field">
        <label htmlFor={`${base}-title`}>{t("common.support.ui.title")}</label>
        <input id={`${base}-title`} value={title} maxLength={200} required placeholder={t("common.support.ui.title_placeholder")} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="erp-field">
        <label htmlFor={`${base}-body`}>{t("common.support.ui.body")}</label>
        <textarea id={`${base}-body`} value={body} rows={5} maxLength={10000} required onChange={(e) => setBody(e.target.value)} />
      </div>
      {hasContext && (
        <fieldset className="erp-field erp-support__context">
          <legend>{t("common.support.ui.context_title")}</legend>
          <span className="erp-small erp-muted">{t("common.support.ui.context_hint")}</span>
          <label className="erp-row">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
            {t("common.support.ui.context_include")}
          </label>
          {attach && (
            <dl className="erp-support__facts">
              <dt>{t("common.support.ui.context_route")}</dt>
              <dd className="erp-mono">{context.route || t("common.none")}</dd>
              {context.selection !== "" && (
                <>
                  <dt>{t("common.support.ui.context_selection")}</dt>
                  <dd>{context.selection}</dd>
                </>
              )}
              {context.consoleErrors.length > 0 && (
                <>
                  <dt>{t("common.support.ui.context_errors")}</dt>
                  <dd>
                    <ul className="erp-support__errors erp-mono" aria-label={t("common.support.ui.context_errors")}>
                      {context.consoleErrors.map((message, i) => (
                        <li key={i}>{message}</li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}
            </dl>
          )}
        </fieldset>
      )}
      {problem && (
        <div role="alert" className="erp-dian erp-dian--bad">
          {problem}
        </div>
      )}
      <div className="erp-dialog__foot">
        <button type="button" className="erp-btn" onClick={() => onOpenChange(false)}>
          {t("common.cancel")}
        </button>
        <button type="submit" className="erp-btn erp-btn--primary" disabled={busy || title.trim() === "" || body.trim() === ""}>
          {busy ? t("common.support.ui.sending") : t("common.support.ui.submit")}
        </button>
      </div>
    </form>
  );
}
