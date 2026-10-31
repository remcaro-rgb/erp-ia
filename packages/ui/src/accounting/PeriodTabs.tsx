"use client";

import { useTranslations } from "next-intl";
import { formatMoney } from "../money";
import { Pill } from "../grid/GridCell";
import { checkFigures } from "./record-tabs-model";
import { MovementsTab, type MovementsTabProps } from "./MovementsTab";
import type { TimelineItem } from "./OriginTab";
import { SimpleTable } from "./record-tables";

// The tabs of a Período (accounting design §8): Resumen (comprobantes by Fuente with their totals), Comprobantes (the grid filtered to
// the period) and Cierre (the checks the close ran with their figures, who signed and when, and the close / reopen history).

export interface PeriodSummaryRow {
  journalId: string;
  journalCode: string;
  journalName: string;
  entries: number;
  debit: number;
  credit: number;
}

export function PeriodSummaryTab({ rows }: { rows: readonly PeriodSummaryRow[] }) {
  const t = useTranslations("accounting.record");
  return (
    <SimpleTable
      label={t("summary_label")}
      empty={t("no_entries")}
      rows={rows}
      rowKey={(r) => r.journalId}
      columns={[
        { key: "journal", header: t("journal"), render: (r) => `${r.journalCode} · ${r.journalName}`, total: t("total") },
        { key: "entries", header: t("entries"), num: true, render: (r) => String(r.entries), total: String(rows.reduce((a, r) => a + r.entries, 0)) },
        { key: "debit", header: t("debit"), num: true, render: (r) => formatMoney(r.debit), total: formatMoney(rows.reduce((a, r) => a + r.debit, 0)) },
        { key: "credit", header: t("credit"), num: true, render: (r) => formatMoney(r.credit), total: formatMoney(rows.reduce((a, r) => a + r.credit, 0)) },
      ]}
    />
  );
}

/** The comprobantes grid of the period: the generic movements tab bound to `accounting.entry`, whose rows are the comprobantes. */
export function PeriodEntriesTab(props: Omit<MovementsTabProps, "entryField">) {
  return <MovementsTab {...props} entryField="id" />;
}

export interface CloseCheckRow {
  id: string;
  check: string;
  passed: boolean;
  value: Record<string, unknown>;
  note: string | null;
  /** Who ran it and when, already formatted in the company's zone. */
  by: string;
  at: string;
}

export interface PeriodCloseTabProps {
  status: string;
  closedAt: string | null;
  closedBy: string | null;
  reopenedCount: number;
  reopenedFor: string | null;
  checks: readonly CloseCheckRow[];
  /** The audit of the period's close and reopen runs; null when the viewer's role cannot read the audit. */
  history: readonly TimelineItem[] | null;
}

export function PeriodCloseTab({ status, closedAt, closedBy, reopenedCount, reopenedFor, checks, history }: PeriodCloseTabProps) {
  const t = useTranslations("accounting.record");
  const tv = useTranslations("accounting.values");
  const name = (check: string) => (tv.has(`close_check.${check}`) ? tv(`close_check.${check}`) : check);
  return (
    <div className="erp-stack">
      <p>
        <Pill tone={status === "closed" ? "gray" : "ok"}>{tv.has(`period_status.${status}`) ? tv(`period_status.${status}`) : status}</Pill>{" "}
        {status === "closed" && closedAt ? t("closed_on", { at: closedAt, by: closedBy ?? "—" }) : null}
        {reopenedCount > 0 ? <span className="erp-muted"> · {t("reopened", { count: reopenedCount })}</span> : null}
        {reopenedFor ? <span> · {t("reopened_for", { date: reopenedFor })}</span> : null}
      </p>
      <h3 className="erp-origin__title">{t("checks")}</h3>
      <SimpleTable
        label={t("checks_label")}
        empty={t("no_checks")}
        rows={checks}
        rowKey={(c) => c.id}
        columns={[
          { key: "check", header: t("check"), render: (c) => name(c.check) },
          { key: "result", header: t("result"), render: (c) => <Pill tone={c.passed ? "ok" : "danger"}>{c.passed ? t("passed") : t("failed")}</Pill> },
          {
            key: "figures",
            header: t("figures"),
            render: (c) => (
              <span className="erp-small">
                {checkFigures(c.value, (n) => formatMoney(n)).map((f) => `${f.key}: ${f.text}`).join(" · ") || c.note || "—"}
              </span>
            ),
          },
          { key: "by", header: t("signed_by"), render: (c) => c.by },
          { key: "at", header: t("at"), mono: true, render: (c) => c.at },
        ]}
      />
      <h3 className="erp-origin__title">{t("history")}</h3>
      {history === null || history.length === 0 ? (
        <p className="erp-muted erp-small">{t("history_empty")}</p>
      ) : (
        <ol className="erp-origin__timeline" aria-label={t("history")}>
          {history.map((item) => (
            <li key={item.id}>
              <time className="erp-mono erp-small">{item.at}</time> <b>{item.process}</b> · {item.action} · <span className="erp-muted">{item.actor}</span> <Pill tone="gray">{item.origin}</Pill>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
