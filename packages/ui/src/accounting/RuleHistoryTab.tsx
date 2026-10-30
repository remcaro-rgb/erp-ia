"use client";

import { useTranslations } from "next-intl";
import { Pill } from "../grid/GridCell";

// The Historial tab of a Regla contable (accounting design §8): the audit of the rule's changes, newest first, with the fields each one
// changed. The audit is read by the company admin only; anyone else is told so.

export interface RuleChange {
  id: string;
  at: string;
  actor: string;
  /** The process, in words. */
  process: string;
  origin: string;
  /** The changed fields: label and a short before → after. */
  fields: { label: string; before: string; after: string }[];
}

export function RuleHistoryTab({ changes }: { changes: readonly RuleChange[] | null }) {
  const t = useTranslations("common.acc_record.rule");
  if (changes === null) return <p className="erp-muted erp-small">{t("history_denied")}</p>;
  if (changes.length === 0) return <p className="erp-muted erp-small">{t("history_empty")}</p>;
  return (
    <ol className="erp-origin__timeline" aria-label={t("history_label")}>
      {changes.map((c) => (
        <li key={c.id}>
          <time className="erp-mono erp-small">{c.at}</time> <b>{c.process}</b> · <span className="erp-muted">{c.actor}</span> <Pill tone="gray">{c.origin}</Pill>
          {c.fields.length > 0 && (
            <ul className="erp-small">
              {c.fields.map((f) => (
                <li key={f.label}>
                  {f.label}: <span className="erp-muted">{f.before}</span> → {f.after}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}
