"use client";

import { useTranslations } from "next-intl";
import { Pill } from "../grid/GridCell";
import { RecordLink } from "../record/RecordLink";

// The Origen tab of a comprobante (accounting design §4.6, §8): where it came from — a person, a template, an import or the posting
// engine with the event and the rule — the document it was made for, what it reverses or was reversed by, and the audit chain of
// the run as a timeline (the audit is read by the company admin only; anyone else sees the rest).

export interface OriginLink {
  label: string;
  /** The record to link to when it has a page the viewer may open (rule 21); plain text otherwise. */
  record?: { entity: string; id: string } | null;
}

export interface TimelineItem {
  id: string;
  /** Already formatted in the company's zone. */
  at: string;
  actor: string;
  /** The process, in words. */
  process: string;
  action: string;
  origin: string;
}

export interface OriginTabProps {
  origin: string;
  source: OriginLink | null;
  /** The event that made the engine post it (`invoicing.invoice.issued`). */
  event: string | null;
  rule: OriginLink | null;
  reversalOf: OriginLink | null;
  reversedBy: OriginLink | null;
  chainId: string | null;
  /** Null when the viewer's role cannot read the audit. */
  timeline: readonly TimelineItem[] | null;
}

const KINDS = new Set(["manual", "template", "auto", "import"]);

export function OriginTab({ origin, source, event, rule, reversalOf, reversedBy, chainId, timeline }: OriginTabProps) {
  const t = useTranslations("accounting.entry.origin");
  const tv = useTranslations("accounting.values.entry_origin");
  const anchor = (l: OriginLink | null) => (l ? (l.record ? <RecordLink entity={l.record.entity} id={l.record.id} label={l.label} /> : <span>{l.label}</span>) : <span className="erp-muted">{t("none")}</span>);
  const kind = KINDS.has(origin) ? origin : "manual";
  return (
    <div className="erp-origin">
      <p>
        <Pill tone={kind === "auto" ? "info" : "gray"}>{tv(kind)}</Pill> {t(kind)}
      </p>
      <dl className="erp-origin__facts">
        {origin === "auto" && (
          <>
            <dt>{t("source")}</dt>
            <dd>{anchor(source)}</dd>
            <dt>{t("event")}</dt>
            <dd className="erp-mono">{event ?? t("none")}</dd>
            <dt>{t("rule")}</dt>
            <dd>{anchor(rule)}</dd>
          </>
        )}
        {reversalOf && (
          <>
            <dt>{t("reversal_of")}</dt>
            <dd>{anchor(reversalOf)}</dd>
          </>
        )}
        {reversedBy && (
          <>
            <dt>{t("reversed_by")}</dt>
            <dd>{anchor(reversedBy)}</dd>
          </>
        )}
        {chainId && (
          <>
            <dt>{t("chain")}</dt>
            <dd className="erp-mono erp-small">{chainId}</dd>
          </>
        )}
      </dl>
      <h3 className="erp-origin__title">{t("timeline")}</h3>
      {timeline === null || timeline.length === 0 ? (
        <p className="erp-muted erp-small">{t("timeline_empty")}</p>
      ) : (
        <ol className="erp-origin__timeline" aria-label={t("timeline")}>
          {timeline.map((item) => (
            <li key={item.id}>
              <time className="erp-mono erp-small">{item.at}</time> <b>{item.process}</b> · {item.action} · <span className="erp-muted">{item.actor}</span> <Pill tone="gray">{item.origin}</Pill>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
