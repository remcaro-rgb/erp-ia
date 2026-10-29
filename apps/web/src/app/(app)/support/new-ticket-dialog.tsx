"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@erp/ui/components/ui/dialog";
import { recordHref } from "@erp/ui";
import type { CloneHandoff } from "@/lib/records/clone-handoff";
import { captureContext } from "@/lib/support/capture";
import type { CapturedContext } from "@/lib/support/capture-model";
import { failureText } from "@/lib/support/failure";
import { createTicketAction } from "@/lib/support/actions";

const KINDS = ["bug", "question", "request"] as const;

export interface NewTicketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the id of the ticket just filed. */
  onCreated: (id: string) => void;
  /** A copy of a ticket ("Duplicar", rule 37): the form starts from it and files it with the source. */
  copy?: CloneHandoff | null;
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
        {props.open && <NewTicketForm key={props.copy ? `copy-${props.copy.handoffId}` : "new"} {...props} />}
      </DialogContent>
    </Dialog>
  );
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** The copied ticket's context as the form shows it; null when the copy has none (the caller may not see it). */
function copiedContext(copy: CloneHandoff | null | undefined): CapturedContext | null {
  const value = copy?.values.context;
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  return { route: text(c.route), selection: text(c.selection), lastAuditIds: texts(c.lastAuditIds), consoleErrors: texts(c.consoleErrors) };
}

function NewTicketForm({ onOpenChange, onCreated, copy }: NewTicketDialogProps) {
  const t = useTranslations();
  const pathname = usePathname();
  const base = useId();
  // Captured when the form opens: what the user selected and the errors seen so far describe the screen before it. A
  // copy keeps the source's context instead (its visible data, rule 37).
  const [context] = useState<CapturedContext>(() => copiedContext(copy) ?? captureContext(pathname));
  const [kind, setKind] = useState<(typeof KINDS)[number]>(() => KINDS.find((k) => k === copy?.values.kind) ?? "bug");
  const [title, setTitle] = useState(() => text(copy?.values.title));
  const [body, setBody] = useState(() => text(copy?.values.body));
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const result = await createTicketAction({ kind, title, body, ...(attach ? { context } : {}) }, copy ? { sourceRowId: copy.sourceRowId } : undefined);
      if (result.ok) {
        onOpenChange(false);
        onCreated(result.id);
        return;
      }
      setProblem(failureText(result, t.has, t));
    } catch {
      setProblem(t("errors.network"));
    } finally {
      setBusy(false);
    }
  };

  const hasContext = context.route !== "" || context.selection !== "" || context.consoleErrors.length > 0;
  const [copyBefore, copyAfter = ""] = (t.raw("common.record.copy_of") as string).split("{name}");
  return (
    <form onSubmit={submit} className="erp-dialog__body">
      {copy && (
        <div role="status" className="erp-dian erp-dian--info">
          <strong>
            {copyBefore}
            <a href={recordHref("support.ticket", copy.sourceRowId)}>{copy.sourceTitle}</a>
            {copyAfter}
          </strong>{" "}
          {t("common.support.ui.copy_note")}
        </div>
      )}
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
