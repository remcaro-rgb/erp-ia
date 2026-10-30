"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { formatMoney } from "../money";
import { Pill } from "../grid/GridCell";
import { SimpleTable } from "./record-tables";

// The Probar tab of a Regla contable (accounting design §5.6, §8): pick a past event of the company and see the comprobante the rule would
// produce from it, line by line, without posting anything (`posting_rule.test`).

export interface RuleTestEvent {
  id: string;
  /** Already formatted in the company's zone. */
  at: string;
  event: string;
}

export interface PreviewLine {
  accountCode?: string | null;
  role?: string | null;
  side: "debit" | "credit";
  amountCompany: number;
  description?: string | null;
}

export type RuleTestResult =
  | { ok: true; lines: PreviewLine[]; description: string | null; reverseOf: string | null }
  | { ok: false; code: string; detail: string };

export interface RuleTestTabProps {
  events: readonly RuleTestEvent[];
  /** Runs the preview as the user (the server action). */
  test: (outboxId: string) => Promise<RuleTestResult | { error: string }>;
  canTest: boolean;
}

export function RuleTestTab({ events, test, canTest }: RuleTestTabProps) {
  const t = useTranslations("common.acc_record.rule");
  const te = useTranslations("errors");
  const [chosen, setChosen] = useState(events[0]?.id ?? "");
  const [result, setResult] = useState<RuleTestResult | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canTest) return <p className="erp-muted erp-small">{t("test_denied")}</p>;
  if (events.length === 0) return <p className="erp-muted erp-small">{t("no_events")}</p>;
  const run = async () => {
    setBusy(true);
    try {
      setResult(await test(chosen));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="erp-stack">
      <div className="erp-row">
        <label className="erp-field__label" htmlFor="rule-test-event">
          {t("event_pick")}
        </label>
        <select id="rule-test-event" value={chosen} onChange={(e) => setChosen(e.target.value)}>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.at} · {e.event}
            </option>
          ))}
        </select>
        <button type="button" className="erp-btn erp-btn--primary" disabled={busy || chosen === ""} onClick={() => void run()}>
          {t("test_run")}
        </button>
      </div>
      {result && "error" in result && (
        <p role="alert" className="erp-dian erp-dian--bad">
          {te.has(result.error) ? te(result.error) : te("unknown")}
        </p>
      )}
      {result && "ok" in result && !result.ok && (
        <p role="alert" className="erp-dian erp-dian--bad">
          <b>{result.code}</b> · {result.detail}
        </p>
      )}
      {result && "ok" in result && result.ok && result.reverseOf && <p className="erp-dian erp-dian--info">{t("reverses", { event: result.reverseOf })}</p>}
      {result && "ok" in result && result.ok && !result.reverseOf && (
        <>
          <p>
            <Pill tone="info">{t("preview")}</Pill> {result.description}
          </p>
          <SimpleTable
            label={t("preview_label")}
            empty={t("no_lines")}
            rows={result.lines}
            rowKey={(l) => `${l.accountCode ?? l.role}|${l.side}|${l.amountCompany}|${l.description ?? ""}`}
            columns={[
              { key: "account", header: t("preview_account"), mono: true, render: (l) => l.accountCode ?? l.role ?? "—" },
              { key: "debit", header: t("side.debit"), num: true, render: (l) => (l.side === "debit" ? formatMoney(l.amountCompany) : ""), total: formatMoney(result.lines.filter((l) => l.side === "debit").reduce((a, l) => a + l.amountCompany, 0)) },
              { key: "credit", header: t("side.credit"), num: true, render: (l) => (l.side === "credit" ? formatMoney(l.amountCompany) : ""), total: formatMoney(result.lines.filter((l) => l.side === "credit").reduce((a, l) => a + l.amountCompany, 0)) },
              { key: "description", header: t("col.description"), render: (l) => l.description ?? "" },
            ]}
          />
        </>
      )}
    </div>
  );
}
