"use client";

import type { MouseEvent } from "react";
import { useTranslations } from "next-intl";
import type { Kpi } from "@erp/kernel";
import { formatCellValue, useCellTimeZone } from "../grid/cell-format";
import { KpiCard } from "./KpiCard";
import { RecommendationCard, type RecommendationItem } from "./RecommendationCard";

// The bodies of the phase 1 widgets. Each gets plain data from the page and calls back for anything that acts.

export interface KpisWidgetProps {
  kpis: Kpi[];
}

export function KpisWidget({ kpis }: KpisWidgetProps) {
  const t = useTranslations("home.kpi");
  if (kpis.length === 0) return <p className="erp-muted erp-small" style={{ padding: "14px 16px" }}>{t("empty")}</p>;
  return (
    <div className="erp-home-kpis">
      {kpis.map((kpi) => (
        <KpiCard key={kpi.id} kpi={kpi} />
      ))}
    </div>
  );
}

export interface RecommendationsWidgetProps {
  items: RecommendationItem[];
  /** Id of the recommendation whose decision is being saved. */
  pendingId?: string | null;
  /** `failed`: the decision could not be saved; `refused`: the suggested action is not the caller's to take. */
  error?: "failed" | "refused" | null;
  onAction: (id: string, processId: string, input: Record<string, unknown>, index: number) => void;
  onLink: (id: string, href: string, index: number) => void;
  onDismiss: (id: string) => void;
}

export function RecommendationsWidget({ items, pendingId = null, error = null, onAction, onLink, onDismiss }: RecommendationsWidgetProps) {
  const t = useTranslations("home.recommendations");
  return (
    <div className="erp-home-recs">
      <span className="erp-muted erp-small">{t("subtitle")}</span>
      {error ? (
        <div role="alert" className="erp-grid__error">
          {t(error)}
        </div>
      ) : null}
      {items.length === 0 ? (
        <div className="erp-muted erp-small">{t("empty")}</div>
      ) : (
        <div className="erp-home-recs__list">
          {items.map((item) => (
            <RecommendationCard
              key={item.id}
              recommendation={item}
              busy={pendingId === item.id}
              onAction={(processId, input, index) => onAction(item.id, processId, input, index)}
              onLink={(href, index) => onLink(item.id, href, index)}
              onDismiss={onDismiss}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export interface RecentRecord {
  entity: string;
  /** i18n key of the entity's name. */
  entityLabel: string;
  id: string;
  title: string | null;
  action: "insert" | "update";
  at: string;
  /** Where the record opens, when it has a screen. */
  href: string | null;
}

export interface RecentWidgetProps {
  records: RecentRecord[];
  onOpen: (href: string) => void;
}

export function RecentWidget({ records, onOpen }: RecentWidgetProps) {
  const t = useTranslations();
  const timeZone = useCellTimeZone();
  if (records.length === 0) return <p className="erp-muted erp-small" style={{ padding: "14px 16px" }}>{t("home.recent.empty")}</p>;
  const open = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    // Let the browser handle a click that asks for a new tab or window.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onOpen(href);
  };
  return (
    <div className="erp-home-list">
      <table>
        <thead>
          <tr>
            <th>{t("home.recent.columns.record")}</th>
            <th>{t("home.recent.columns.kind")}</th>
            <th>{t("home.recent.columns.action")}</th>
            <th className="erp-num">{t("home.recent.columns.when")}</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const title = record.title ?? t("home.recent.untitled");
            return (
              <tr key={`${record.entity}:${record.id}`}>
                <td>
                  {record.href ? (
                    <a className="erp-link" style={{ fontSize: 13 }} href={record.href} aria-label={t("home.recent.open", { title })} onClick={open(record.href)}>
                      {title}
                    </a>
                  ) : (
                    title
                  )}
                </td>
                <td>{t(record.entityLabel)}</td>
                <td>{t(`home.recent.${record.action}`)}</td>
                <td className="erp-num">
                  <time dateTime={record.at}>{formatCellValue({ type: "datetime" }, record.at, { yes: "", no: "", timeZone })}</time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface HelpShortcut {
  id: string;
  /** i18n keys of the shortcut's text and of the question it asks the assistant. */
  labelKey: string;
  questionKey: string;
}

export interface HelpWidgetProps {
  shortcuts: HelpShortcut[];
  /** The user chose a shortcut: the page sends this (already translated) question to the assistant. */
  onAsk: (question: string) => void;
}

export function HelpWidget({ shortcuts, onAsk }: HelpWidgetProps) {
  const t = useTranslations();
  return (
    <div className="erp-home-help">
      <span className="erp-muted erp-small">{t("home.help.subtitle")}</span>
      {shortcuts.map((shortcut) => (
        <button key={shortcut.id} type="button" className="erp-btn" onClick={() => onAsk(t(shortcut.questionKey))}>
          {t(shortcut.labelKey)}
        </button>
      ))}
    </div>
  );
}
