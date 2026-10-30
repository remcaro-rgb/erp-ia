"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "../money";
import { periodName } from "./BalancesTab";
import { netByAccount, periodRange, type AccountMovement, type PeriodLite } from "./record-tabs-model";
import { NoAccess, SimpleTable } from "./record-tables";

// The figures tab of an analytic node (accounting design §8): "Saldos por cuenta" (debit, credit and net per account over a range of
// periods, descendants included) for the auxiliar abierto, ítem and unidad de negocio, and "Resultados" (income and expense by
// period) for the centro de costo.

export interface DimensionBalancesTabProps {
  mode: "accounts" | "results";
  periods: readonly PeriodLite[];
  accounts: readonly AccountMovement[];
  results: readonly { periodId: string; income: number; expense: number }[];
  /** False when the caller may not view the node. */
  allowed: boolean;
}

export function DimensionBalancesTab({ mode, periods, accounts, results, allowed }: DimensionBalancesTabProps) {
  const t = useTranslations("common.acc_record");
  const locale = useLocale();
  const ordered = [...periods].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  // Opens on the range of the latest year that has movement: its first period to its last.
  const moved = new Set([...accounts.map((a) => a.periodId), ...results.filter((r) => r.income !== 0 || r.expense !== 0).map((r) => r.periodId)]);
  const latest = [...ordered].reverse().find((p) => moved.has(p.id)) ?? ordered[ordered.length - 1];
  const firstOfYear = ordered.find((p) => p.year === latest?.year);
  const [from, setFrom] = useState(firstOfYear?.id ?? "");
  const [to, setTo] = useState(latest?.id ?? "");
  if (!allowed) return <NoAccess text={t("no_access")} />;
  const range = periodRange(ordered, from, to);
  const ids = new Set(range.map((p) => p.id));
  const option = (p: PeriodLite) => (
    <option key={p.id} value={p.id}>
      {periodName(p.startsOn, locale)}
    </option>
  );
  const net = netByAccount(accounts, ids);
  const sum = (key: "debit" | "credit" | "net") => net.reduce((acc, r) => acc + r[key], 0);
  const resultRows = range.map((p) => ({ period: p, ...(results.find((r) => r.periodId === p.id) ?? { income: 0, expense: 0 }) }));
  return (
    <div className="erp-stack">
      <div className="erp-row">
        <label className="erp-field__label" htmlFor="dim-from">
          {t("from")}
        </label>
        <select id="dim-from" value={from} onChange={(e) => setFrom(e.target.value)}>
          {ordered.map(option)}
        </select>
        <label className="erp-field__label" htmlFor="dim-to">
          {t("to")}
        </label>
        <select id="dim-to" value={to} onChange={(e) => setTo(e.target.value)}>
          {ordered.map(option)}
        </select>
      </div>
      {mode === "accounts" ? (
        <SimpleTable
          label={t("accounts_label")}
          empty={t("no_movement")}
          rows={net}
          rowKey={(r) => r.accountId}
          columns={[
            { key: "account", header: t("account"), render: (r) => `${r.code} · ${r.name}`, total: t("total") },
            { key: "debit", header: t("debit"), num: true, render: (r) => formatMoney(r.debit), total: formatMoney(sum("debit")) },
            { key: "credit", header: t("credit"), num: true, render: (r) => formatMoney(r.credit), total: formatMoney(sum("credit")) },
            { key: "net", header: t("net"), num: true, render: (r) => formatMoney(r.net), total: formatMoney(sum("net")) },
          ]}
        />
      ) : (
        <SimpleTable
          label={t("results_label")}
          empty={t("no_periods")}
          rows={resultRows}
          rowKey={(r) => r.period.id}
          columns={[
            { key: "period", header: t("period"), render: (r) => periodName(r.period.startsOn, locale), total: t("total") },
            { key: "income", header: t("income"), num: true, render: (r) => formatMoney(r.income), total: formatMoney(resultRows.reduce((a, r) => a + r.income, 0)) },
            { key: "expense", header: t("expense"), num: true, render: (r) => formatMoney(r.expense), total: formatMoney(resultRows.reduce((a, r) => a + r.expense, 0)) },
            { key: "result", header: t("result"), num: true, render: (r) => formatMoney(r.income - r.expense), total: formatMoney(resultRows.reduce((a, r) => a + r.income - r.expense, 0)) },
          ]}
        />
      )}
    </div>
  );
}
