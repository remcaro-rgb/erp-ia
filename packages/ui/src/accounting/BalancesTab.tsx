"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "../money";
import { defaultYear, periodsOfYear, yearsOf, type PeriodLite } from "./record-tabs-model";
import { NoAccess, SimpleTable } from "./record-tables";

// The Saldos tab of a Cuenta (accounting design §8): debit, credit and the running balance of each period of the chosen fiscal year,
// with the account's descendants. A caller without view on the account gets "Sin acceso" instead of figures (§5.13).

export interface BalancesTabProps {
  periods: readonly PeriodLite[];
  /** Per period; null when the caller may not view the account. */
  rows: readonly { periodId: string; debit: number; credit: number; balance: number }[] | null;
}

/** "Octubre 2026" for a period starting on `startsOn` (`YYYY-MM-DD`). */
export function periodName(startsOn: string, locale: string): string {
  const text = new Date(`${startsOn}T00:00:00Z`).toLocaleDateString(locale === "en" ? "en-US" : "es-CO", { month: "long", year: "numeric", timeZone: "UTC" });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function BalancesTab({ periods, rows }: BalancesTabProps) {
  const t = useTranslations("accounting.record");
  const locale = useLocale();
  const withFigures = new Set((rows ?? []).filter((r) => r.debit !== 0 || r.credit !== 0).map((r) => r.periodId));
  const [chosen, setChosen] = useState<number | null>(null);
  if (rows === null) return <NoAccess text={t("no_access")} />;
  const year = chosen ?? defaultYear(periods, withFigures);
  const byPeriod = new Map(rows.map((r) => [r.periodId, r]));
  const shown = periodsOfYear(periods, year);
  return (
    <div className="erp-stack">
      <div className="erp-row">
        <label className="erp-field__label" htmlFor="balances-year">
          {t("year")}
        </label>
        <select id="balances-year" value={year ?? ""} onChange={(e) => setChosen(Number(e.target.value))}>
          {yearsOf(periods).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      <SimpleTable
        label={t("balances_label")}
        empty={t("no_periods")}
        rows={shown}
        rowKey={(p) => p.id}
        columns={[
          { key: "period", header: t("period"), render: (p) => periodName(p.startsOn, locale) },
          { key: "debit", header: t("debit"), num: true, render: (p) => formatMoney(byPeriod.get(p.id)?.debit ?? 0) },
          { key: "credit", header: t("credit"), num: true, render: (p) => formatMoney(byPeriod.get(p.id)?.credit ?? 0) },
          { key: "balance", header: t("balance"), num: true, render: (p) => formatMoney(byPeriod.get(p.id)?.balance ?? 0) },
        ]}
      />
    </div>
  );
}
