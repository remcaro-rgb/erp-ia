"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ProcessId } from "@erp/ui";
import { POSTING_MODES, type PostingMode, type PostingModeData } from "@/lib/accounting/posting-mode";
import { setPostingModeAction } from "@/lib/accounting/posting-actions";
import { AdminDialog } from "../../admin/_components/admin-dialog";
import { useAdminAction } from "../../admin/_components/use-admin-action";

/**
 * The posting mode at the top of Mapeo de cuentas (Task 33, R33-9): the two modes as a radio group, editable only with
 * `accounting.posting_mode.set` and confirmed with the TOTP (the standard step-up, rule 15). While the mode is asynchronous, and in the dialog
 * before choosing it, a warning block says the risk. Under it, what awaits the ledger (both modes: a queue can be left over after a switch) and the
 * documentos the mode applies to.
 */
export function PostingModeCard({ data, canEdit }: { data: PostingModeData; canEdit: boolean }) {
  const t = useTranslations("accounting.pages.posting.mode");
  const [target, setTarget] = useState<PostingMode | null>(null);
  const label = (mode: PostingMode) => (mode === "inline_strict" ? t("inline_strict") : t("asynchronous"));
  const hint = (mode: PostingMode) => (mode === "inline_strict" ? t("inline_strict_hint") : t("asynchronous_hint"));

  return (
    <section className="erp-card" aria-labelledby="posting-mode-title">
      <div className="erp-admin__head">
        <h2 id="posting-mode-title">{t("title")}</h2>
        <span className="erp-small erp-muted">{t("hint")}</span>
      </div>
      <div role="radiogroup" aria-label={t("group")} className="erp-stack">
        {POSTING_MODES.map((mode) => (
          <label key={mode} className="erp-field" style={{ cursor: canEdit ? "pointer" : "default" }}>
            <span className="erp-row">
              <input type="radio" name="posting-mode" value={mode} checked={data.mode === mode} disabled={!canEdit} onChange={() => setTarget(mode)} />
              <b>{label(mode)}</b>
            </span>
            <span className="erp-small erp-muted">{hint(mode)}</span>
          </label>
        ))}
      </div>
      {!canEdit && <p className="erp-small erp-muted">{t("read_only")}</p>}
      {data.mode === "asynchronous" && (
        <div role="alert" className="erp-dian erp-dian--bad" data-testid="posting-mode-warning">
          {t("warning")}
        </div>
      )}
      <p className="erp-row">
        <span data-testid="posting-mode-pending-documents">{t("pending_documents", { count: data.pendingDocuments })}</span>
        <span data-testid="posting-mode-pending-failures">{t("pending_failures", { count: data.pendingFailures })}</span>
        <Link href="/accounting/posting?tab=pending">{t("see_pending")}</Link>
      </p>
      <p className="erp-small erp-muted" data-testid="posting-mode-documents">
        {t("applies_to", { documents: data.documents.map((key) => (t.has(`document.${key}`) ? t(`document.${key}`) : key)).join(", ") })}
      </p>
      {target && <ChangeDialog data={data} target={target} label={label(target)} onClose={() => setTarget(null)} />}
    </section>
  );
}

function ChangeDialog({ data, target, label, onClose }: { data: PostingModeData; target: PostingMode; label: string; onClose: () => void }) {
  const t = useTranslations("accounting.pages.posting.mode");
  const { execute, prompt, status, busy } = useAdminAction();
  return (
    <AdminDialog
      open
      title={t("change_title")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy} onClick={() => void execute((token) => setPostingModeAction(target, token)).then((r) => r.ok && onClose())}>
            {t("change_confirm", { mode: label })}
          </button>
        </>
      }
    >
      {target === "asynchronous" && (
        <div role="alert" className="erp-dian erp-dian--bad">
          {t("warning")}
        </div>
      )}
      <p>{target === "asynchronous" ? t("change_asynchronous") : t("change_inline_strict")}</p>
      {(data.pendingDocuments > 0 || data.pendingFailures > 0) && (
        <p className="erp-small">
          {t("pending_documents", { count: data.pendingDocuments })} · {t("pending_failures", { count: data.pendingFailures })}
        </p>
      )}
      <div className="erp-small erp-muted">
        <ProcessId id="accounting.posting_mode.set" />
      </div>
      {status}
      {prompt}
    </AdminDialog>
  );
}
