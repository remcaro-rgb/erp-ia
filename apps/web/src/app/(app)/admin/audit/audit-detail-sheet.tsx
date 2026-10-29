"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@erp/ui/components/ui/sheet";
import { auditEntryAction, type AuditEntryResult } from "@/lib/admin/audit-actions";
import { SYSTEM_ACTOR, type AuditCatalogue } from "@/lib/admin/audit-links";
import type { AuditDetailView } from "@/lib/admin/audit-view";

export interface AuditDetailSheetProps {
  /** The entry to show; null keeps the sheet closed. */
  id: string | null;
  catalogue: AuditCatalogue;
  onClose: () => void;
}

/** One `label · antes → después` (or `label · valor`) line; a masked value says so to a screen reader. */
function Value({ text, masked }: { text: string; masked: boolean }) {
  const t = useTranslations();
  return masked ? (
    <span className="erp-masked" title={t("common.admin.audit.detail.masked")}>
      {text}
    </span>
  ) : (
    <span>{text}</span>
  );
}

function Link({ href, children }: { href: string | null; children: React.ReactNode }) {
  return href ? (
    <a className="erp-link erp-link--inline" href={href}>
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

function Detail({ view, catalogue }: { view: AuditDetailView; catalogue: AuditCatalogue }) {
  const t = useTranslations();
  const actorName = view.actor.userId === SYSTEM_ACTOR ? t("common.admin.audit.system") : ((view.actor.userId ? catalogue.members[view.actor.userId] : undefined) ?? view.actor.email ?? "—");
  return (
    <div className="erp-audit-detail">
      <dl className="erp-audit-detail__facts">
        <dt>{t("field.kernel.audit.process_id")}</dt>
        <dd className="erp-mono">{view.process?.id ?? "—"}</dd>
        <dt>{t("field.kernel.audit.entity")}</dt>
        <dd>
          {view.entityLabel ?? <span className="erp-mono">{view.entity}</span>}
        </dd>
        <dt>{t("field.kernel.audit.row_id")}</dt>
        <dd>
          {view.rowId ? (
            <Link href={view.rowHref}>{view.rowTitle ?? <span className="erp-mono">{view.rowId}</span>}</Link>
          ) : (
            "—"
          )}
        </dd>
        {view.source && (
          <>
            <dt>{t("common.admin.audit.detail.source")}</dt>
            <dd>
              <Link href={view.source.href}>{view.source.title ?? <span className="erp-mono">{view.source.id}</span>}</Link>
            </dd>
          </>
        )}
        <dt>{t("field.kernel.audit.actor")}</dt>
        <dd>
          <Link href={view.actor.href}>{actorName}</Link>
        </dd>
        <dt>{t("field.kernel.audit.chain_id")}</dt>
        <dd className="erp-mono">{view.chainId}</dd>
      </dl>

      <h3 className="erp-audit-detail__heading">{t("common.admin.audit.detail.changes")}</h3>
      {!view.described ? (
        <p className="erp-small erp-muted">{t("common.admin.audit.detail.no_fields")}</p>
      ) : view.changes.length === 0 ? (
        <p className="erp-small erp-muted">{t("common.admin.audit.detail.no_changes")}</p>
      ) : (
        <ul className="erp-audit-detail__list">
          {view.changes.map((change) => (
            <li key={change.field}>
              <span className="erp-audit-detail__label">{change.label}</span>
              {" · "}
              <Value text={change.before} masked={change.masked} />
              {" → "}
              <Value text={change.after} masked={change.masked} />
            </li>
          ))}
        </ul>
      )}

      {view.input && view.input.length > 0 && (
        <>
          <h3 className="erp-audit-detail__heading">{t("common.admin.audit.detail.input")}</h3>
          <ul className="erp-audit-detail__list">
            {view.input.map((item) => (
              <li key={item.key}>
                <span className="erp-audit-detail__label">{item.label}</span>
                {" · "}
                <Value text={item.value} masked={item.masked} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * One audit entry in a side sheet (design §22.14, rule 16): the process's description as its title, when, from where and
 * what it did, its record, the record it was cloned from and its actor as links (rule 21), then each changed field as
 * `label · antes → después` and, for a creation or a refusal, what it received. Read through kernel.audit.entry, so the
 * viewer's field visibility applies (•••••• for a masked field).
 */
export function AuditDetailSheet({ id, catalogue, onClose }: AuditDetailSheetProps) {
  const t = useTranslations();
  const [loaded, setLoaded] = useState<{ id: string; result: AuditEntryResult } | null>(null);
  useEffect(() => {
    if (id === null) return;
    let current = true;
    auditEntryAction(id)
      .then((result) => current && setLoaded({ id, result }))
      .catch(() => current && setLoaded({ id, result: { ok: false, code: "network" } }));
    return () => {
      current = false;
    };
  }, [id]);
  const result = loaded && loaded.id === id ? loaded.result : null;
  const view = result?.ok ? result.view : null;
  const title = view ? (view.process?.description ?? view.process?.id ?? t("common.admin.audit.detail.direct")) : t("entity.kernel.audit");

  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" showCloseButton={false} className="erp-sheet">
        <div className="erp-audit-detail__head">
          <SheetTitle className="erp-audit-detail__title">{title}</SheetTitle>
          <SheetDescription className="erp-small erp-muted">
            {view ? `${view.occurredAt} · ${t(`grid.values.audit_action.${view.action}`)} · ${t(`grid.values.audit_origin.${view.origin}`)}` : t("common.loading")}
          </SheetDescription>
        </div>
        <button type="button" className="erp-btn erp-btn--ghost erp-sheet__close" aria-label={t("common.close")} onClick={onClose}>
          ✕
        </button>
        {result && !result.ok && (
          <p role="alert" className="erp-sheet__state">
            {t("common.admin.audit.detail.failed")}
          </p>
        )}
        {view && <Detail view={view} catalogue={catalogue} />}
      </SheetContent>
    </Sheet>
  );
}
