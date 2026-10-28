"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Kpi } from "@erp/kernel";
import { detailParams, formatCompact, formatCount } from "./format";

export interface KpiCardProps {
  kpi: Kpi;
}

/**
 * One indicator of the home screen (prototype `.kpi`): the label, the number, an optional share bar and a detail line. The
 * provider sends i18n keys and raw numbers; the language and the number formats are the screen's (rule 24).
 */
export function KpiCard({ kpi }: KpiCardProps) {
  const t = useTranslations();
  const locale = useLocale();
  const value = kpi.unit === "percent" ? `${formatCount(locale, kpi.value)} %` : kpi.unit === "tokens" ? formatCompact(locale, kpi.value) : formatCount(locale, kpi.value);
  return (
    <div className="erp-home-kpi" data-kpi={kpi.id}>
      <div className="erp-home-kpi__label">{t(kpi.label)}</div>
      <div className="erp-home-kpi__value" data-testid="kpi-value" data-tone={kpi.tone ?? "default"}>
        {value}
      </div>
      {kpi.progress !== undefined ? (
        <div
          className="erp-bar"
          style={{ marginTop: 8, height: 6 }}
          role="progressbar"
          aria-label={t(kpi.label)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(kpi.progress * 100)}
        >
          <i style={{ width: `${Math.round(kpi.progress * 100)}%` }} />
        </div>
      ) : null}
      {kpi.detail ? <div className="erp-home-kpi__detail">{t(kpi.detail.key, detailParams(locale, kpi.detail.params))}</div> : null}
    </div>
  );
}
