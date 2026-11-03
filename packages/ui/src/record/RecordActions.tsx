"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Ban, CheckCircle2, Copy, FilePlus2, Mail, Printer, Save, Send, Trash2, Undo2, XCircle } from "lucide-react";
import { StepUpPrompt } from "../forms/StepUpPrompt";
import { barButtons, NEEDS_REASON, postsAutomatically, type BarAction, type EntityKind, type LifecycleFlags, type RecordBarAction, type RecordRights, type RecordStatus } from "./record-actions-model";

// The standard action bar of a maestro or documento record (entity types spec §5, design §10 D15–D17, approved prototype): on the
// left Nuevo · Imprimir · Notificar (documentos) · Duplicar · Revertir (a module action, next to Duplicar), Duplicar and Revertir under
// «Más ▾» below 768 px; on the right the state buttons of `barButtons` (allowedActions ∩ rights). State buttons wait while the form
// holds unsaved edits; No aprobar, Anular and Revertir ask for the reason; Eliminar asks to confirm. A refused action (a posting
// refusal included) is shown as an inline alert under the bar with its reason, and the form keeps the user's edits.

/** What running an action answers. `step_up_required` makes the bar ask for the code and run it again with the token. */
export type RecordActionOutcome = { ok: true; message?: string } | { ok: false; code: string; messages: string[] };

export interface RecordActionsProps {
  entityType: EntityKind;
  /** The record's status; a new record is `draft`. */
  status: RecordStatus;
  flags: LifecycleFlags;
  rights: RecordRights;
  /** The form holds unsaved edits. */
  dirty: boolean;
  /** The form's data cannot be saved yet (client errors, missing data): Guardar waits. */
  saveBlocked?: boolean;
  /** The tools on the left the caller may use here; each shows only when true. Notificar shows on documentos only (D17). */
  tools?: { new?: boolean; print?: boolean; notify?: boolean; duplicate?: boolean; reverse?: boolean };
  /** Runs the action; `stepUp` is the token of a fresh verification when the process asked for one. */
  onAction: (action: RecordBarAction, input: { reason?: string }, stepUp?: string) => Promise<RecordActionOutcome>;
  requestStepUp?: (code: string) => Promise<{ token: string } | { error: string }>;
  /** Busy elsewhere (the form is saving). */
  disabled?: boolean;
  /** A refusal to show from the start (a new record saved, then refused, opens with it). */
  initialProblem?: string | null;
  /** A success notice to show from the start: the action's, kept across the navigation that followed it (minor 7). */
  initialNotice?: string | null;
  /** Receives what ⌘S / Ctrl+S in the form runs: the bar's Guardar. */
  registerShortcut?: (run: () => void) => void;
}

const ICONS: Record<BarAction, typeof Save> = { save: Save, save_submit: Send, submit: Send, approve: CheckCircle2, reject: XCircle, void: Ban, delete: Trash2 };

export function RecordActions({ entityType, status, flags, rights, dirty, saveBlocked = false, tools = {}, onAction, requestStepUp, disabled = false, initialProblem = null, initialNotice = null, registerShortcut }: RecordActionsProps) {
  const t = useTranslations("common.record.actions");
  const te = useTranslations("errors");
  const id = useId();
  const [asking, setAsking] = useState<RecordBarAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(initialProblem);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  // Minor 2: one run at a time, whatever React has rendered yet (a double click lands before the buttons disable).
  const running = useRef(false);
  const [stepUp, setStepUp] = useState<{ action: RecordBarAction; reason?: string } | null>(null);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const away = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [moreOpen]);

  const buttons = barButtons(entityType, status, flags, rights);
  const off = disabled || busy;
  const isDocumento = entityType === "documento";

  const run = async (action: RecordBarAction, input: { reason?: string }, token?: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const outcome = await onAction(action, input, token);
      if (outcome.ok) {
        setStepUp(null);
        setAsking(null);
        setReason("");
        setNotice(outcome.message ?? null);
      } else if (outcome.code === "shown") {
        // The form already shows why (its fields, its step-up prompt).
        setStepUp(null);
      } else if (outcome.code === "step_up_required" && requestStepUp) {
        setStepUp({ action, ...(input.reason ? { reason: input.reason } : {}) });
      } else {
        setStepUp(null);
        const why = outcome.messages.length > 0 ? outcome.messages.join(" · ") : te.has(outcome.code) ? te(outcome.code) : te("unknown");
        setProblem(outcome.code === "stale_record" ? t("stale") : action === "save_submit" && outcome.code === "saved_not_submitted" ? why : t("refused", { action: t(action), reason: why }));
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const click = (action: RecordBarAction) => {
    setMoreOpen(false);
    if (NEEDS_REASON.has(action) || action === "delete") {
      setAsking(action);
      setReason("");
      setProblem(null);
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

  const tool = (action: "new" | "print" | "notify" | "duplicate" | "reverse", Icon: typeof Save, extra: { blockedBy?: string | null; className?: string } = {}) => (
    <button
      key={action}
      type="button"
      {...(action === "duplicate" ? { "aria-keyshortcuts": "Control+D Meta+D" } : {})}
      className={["erp-btn", "erp-touch", extra.className].filter(Boolean).join(" ")}
      disabled={off || !!extra.blockedBy}
      title={extra.blockedBy ?? undefined}
      onClick={() => click(action)}
    >
      <Icon aria-hidden size={16} />
      {t(action)}
    </button>
  );
  const canSave = buttons.some((b) => b.action === "save") && !off && !saveBlocked;
  const latestSave = useRef<() => void>(() => {});
  latestSave.current = () => {
    if (canSave) click("save");
  };
  useEffect(() => {
    registerShortcut?.(() => latestSave.current());
  }, [registerShortcut]);
  const notifyBlock = dirty ? t("unsaved") : status === "draft" ? t("draft_notify") : null;

  return (
    <div className="erp-actbar" role="group" aria-label={t("group")}>
      <div className="erp-actbar__row">
        <div className="erp-actbar__tools">
          {tools.new && tool("new", FilePlus2)}
          {tools.print && tool("print", Printer, { blockedBy: dirty ? t("unsaved_print") : null })}
          {isDocumento && tools.notify && tool("notify", Mail, { blockedBy: notifyBlock })}
          {tools.duplicate && tool("duplicate", Copy, { className: "erp-actbar__wide" })}
          {tools.reverse && tool("reverse", Undo2, { className: "erp-actbar__wide" })}
          {(tools.duplicate || tools.reverse) && (
            <span ref={moreRef} className="erp-actbar__more">
              <button type="button" className="erp-btn erp-touch" aria-haspopup="menu" aria-expanded={moreOpen} disabled={off} onClick={() => setMoreOpen((o) => !o)}>
                {t("more")} ▾
              </button>
              {moreOpen && (
                <span role="menu" className="erp-actbar__menu">
                  {tools.duplicate && (
                    <button type="button" role="menuitem" className="erp-btn erp-touch" onClick={() => click("duplicate")}>
                      <Copy aria-hidden size={16} />
                      {t("duplicate")}
                    </button>
                  )}
                  {tools.reverse && (
                    <button type="button" role="menuitem" className="erp-btn erp-touch" onClick={() => click("reverse")}>
                      <Undo2 aria-hidden size={16} />
                      {t("reverse")}
                    </button>
                  )}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="erp-actbar__main">
          {buttons.map((b) => {
            const Icon = ICONS[b.action];
            const blocked = (b.state && dirty) || ((b.action === "save" || b.action === "save_submit") && saveBlocked);
            const cls = b.primary ? "erp-btn erp-btn--primary" : b.tone === "ok" ? "erp-btn erp-btn--ok" : b.tone === "danger" ? "erp-btn erp-btn--danger" : "erp-btn";
            return (
              <button
                key={b.action}
                type="button"
                data-action={b.action}
                className={`${cls} erp-touch`}
                disabled={off || blocked}
                aria-describedby={b.state && dirty ? `${id}-unsaved` : undefined}
                onClick={() => click(b.action)}
              >
                <Icon aria-hidden size={16} />
                {t(b.action)}
              </button>
            );
          })}
          {busy && <span className="erp-small erp-muted">{t("acting")}</span>}
        </div>
      </div>
      {dirty && buttons.some((b) => b.state) && (
        <p id={`${id}-unsaved`} className="erp-small erp-muted">
          {t("unsaved")}
        </p>
      )}
      {postsAutomatically(entityType, status, flags) && buttons.length > 0 && <p className="erp-small erp-muted">{t("posts_auto")}</p>}
      {asking === "delete" && (
        <div className="erp-row erp-actbar__ask" role="group" aria-label={t("delete")}>
          <span className="erp-small">{t("delete_confirm")}</span>
          <button type="button" className="erp-btn erp-btn--danger erp-touch" disabled={busy} onClick={() => void run("delete", {})}>
            {t("delete_yes")}
          </button>
          <button type="button" className="erp-btn erp-touch" onClick={() => setAsking(null)}>
            {t("cancel")}
          </button>
        </div>
      )}
      {asking && NEEDS_REASON.has(asking) && (
        <div className="erp-row erp-actbar__ask" role="group" aria-label={t(`reason_${asking as "reject" | "void" | "reverse"}`)}>
          <label htmlFor={`${id}-reason`} className="erp-small">
            {t("reason")}
          </label>
          <input id={`${id}-reason`} value={reason} maxLength={1000} autoFocus onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="erp-btn erp-btn--primary erp-touch" disabled={busy || reason.trim() === ""} onClick={() => void run(asking, { reason: reason.trim() })}>
            {t("confirm")}
          </button>
          <button type="button" className="erp-btn erp-touch" onClick={() => setAsking(null)}>
            {t("cancel")}
          </button>
        </div>
      )}
      {stepUp && <StepUpPrompt onConfirm={(code) => void confirmStepUp(code)} onCancel={() => setStepUp(null)} error={stepUpError} busy={busy} />}
      {problem && (
        <div role="alert" className="erp-dian erp-dian--bad erp-actbar__alert">
          {problem}
          {problem === t("stale") && (
            <>
              {" "}
              <button type="button" className="erp-btn erp-btn--sm" onClick={() => window.location.reload()}>
                {t("reload")}
              </button>
            </>
          )}
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
