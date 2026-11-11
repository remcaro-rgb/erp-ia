"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Chart } from "@erp/kernel";
import { formatMoney } from "../money";
import { formatCompact, formatCount } from "./format";

export interface ChartCardProps {
  chart: Chart;
}

/** Series colours: the brand, the warning tint, then the muted text. */
const SERIES_COLORS = ["var(--primary)", "var(--warn)", "var(--text-muted)"] as const;
const LONG_LABEL = 12;

/** A value as the chart's unit reads it: in full for the accessible text, compact on the marks. */
function useFormat(unit: Chart["unit"]) {
  const locale = useLocale();
  const full = (value: number) => (unit === "money" ? formatMoney(value) : unit === "percent" ? `${formatCount(locale, value)} %` : unit === "tokens" ? formatCompact(locale, value) : formatCount(locale, value));
  const compact = (value: number) => (unit === "count" ? formatCount(locale, value) : formatCompact(locale, value));
  return { full, compact };
}

/**
 * One chart of a module's Inicio (design §19a): bars (vertical and grouped by series, or horizontal when the labels are long) or a
 * trend line, drawn from the provider's language-neutral data. Plain SVG/HTML, no chart library; the whole chart is one image for
 * assistive technology with its values read out ("Ingresos: 2026-10: $ 1.000,00; …").
 */
export function ChartCard({ chart }: ChartCardProps) {
  const t = useTranslations();
  const { full, compact } = useFormat(chart.unit);
  const name = (label: string) => (chart.i18n ? t(label) : label);
  const labels = chart.series[0]?.points.map((p) => p.label) ?? [];
  const empty = chart.series.every((s) => s.points.length === 0);
  const summary = chart.series
    .map((s) => `${chart.series.length > 1 ? `${t(s.label)}: ` : ""}${s.points.map((p) => `${name(p.label)} ${full(p.value)}`).join("; ")}`)
    .join(". ");

  if (empty) return <p className="erp-muted erp-small" style={{ padding: "14px 16px" }}>{t("home.module.chart_empty")}</p>;

  const legend =
    chart.series.length > 1 ? (
      <ul className="erp-chart__legend" aria-hidden="true">
        {chart.series.map((s, i) => (
          <li key={s.label}>
            <i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {t(s.label)}
          </li>
        ))}
      </ul>
    ) : null;

  let body;
  if (chart.kind === "line") {
    const series = chart.series[0]!;
    const values = series.points.map((p) => p.value);
    const max = Math.max(0, ...values);
    const min = Math.min(0, ...values);
    const span = max - min || 1;
    const width = 300;
    const height = 110;
    const pad = 4;
    const x = (i: number) => (values.length < 2 ? width / 2 : (i * width) / (values.length - 1));
    const y = (v: number) => height - pad - ((v - min) / span) * (height - 2 * pad);
    const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" L");
    const first = series.points[0]!;
    const last = series.points.at(-1)!;
    body = (
      <div className="erp-chart__line">
        <div className="erp-chart__axis">
          <span>{compact(max)}</span>
          <strong data-testid="chart-last">{full(last.value)}</strong>
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          <path d={`M0,${y(0).toFixed(1)} L${width},${y(0).toFixed(1)}`} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" fill="none" />
          <path d={`M0,${height} L${line} L${width},${height} Z`} fill="var(--accent)" />
          <path d={`M${line}`} fill="none" stroke="var(--primary)" strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="erp-chart__axis">
          <span>{name(first.label)}</span>
          <span>{name(last.label)}</span>
        </div>
      </div>
    );
  } else {
    const peak = Math.max(1e-9, ...chart.series.flatMap((s) => s.points.map((p) => Math.abs(p.value))));
    const horizontal = chart.series.length === 1 && labels.some((l) => name(l).length > LONG_LABEL);
    const bar = (value: number, i: number) => ({ background: SERIES_COLORS[i % SERIES_COLORS.length], ...(value < 0 ? { opacity: 0.55 } : {}) });
    body = horizontal ? (
      <ul className="erp-chart__rows">
        {chart.series[0]!.points.map((p) => (
          <li key={p.label}>
            <span className="erp-chart__rowlabel" title={name(p.label)}>
              {name(p.label)}
            </span>
            <span className="erp-chart__track">
              <i style={{ ...bar(p.value, 0), width: `${(Math.abs(p.value) / peak) * 100}%` }} />
            </span>
            <span className="erp-chart__rowvalue">{compact(p.value)}</span>
          </li>
        ))}
      </ul>
    ) : (
      <div className="erp-chart__cols">
        {labels.map((label, at) => (
          <div key={label} className="erp-chart__col">
            <div className="erp-chart__bars">
              {chart.series.map((s, i) => {
                const value = s.points[at]?.value ?? 0;
                return (
                  <span key={s.label} className="erp-chart__bar" title={`${t(s.label)}: ${full(value)}`}>
                    <em>{compact(value)}</em>
                    <i style={{ ...bar(value, i), height: `${(Math.abs(value) / peak) * 100}%` }} />
                  </span>
                );
              })}
            </div>
            <span className="erp-chart__collabel">{name(label)}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="erp-chart" role="img" aria-label={t("home.module.chart_summary", { title: t(chart.label), summary })} data-chart={chart.id} data-kind={chart.kind}>
      {legend}
      {body}
    </div>
  );
}
