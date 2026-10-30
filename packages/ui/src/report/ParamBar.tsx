"use client";

import { useTranslations } from "next-intl";
import { asSelect, hasDateRange, quickRanges, type DateRange, type ParamSpec, type ParamValue, type ReportParams } from "./report-model";

export interface ParamBarProps {
  /** The parameters to offer (already without the hidden ones). */
  specs: readonly ParamSpec[];
  value: ReportParams;
  onChange: (next: ReportParams) => void;
  /** Today as `YYYY-MM-DD` in the company's time zone. */
  today: string;
  period?: DateRange;
}

/** The parameter bar a report's schema generates (design §9): one control per parameter, and the quick ranges when it has `from` / `to`. */
export function ParamBar({ specs, value, onChange, today, period }: ParamBarProps) {
  const t = useTranslations();
  const set = (name: string, next: ParamValue | undefined) => {
    const copy = { ...value };
    if (next === undefined || next === "") delete copy[name];
    else copy[name] = next;
    onChange(copy);
  };
  const ranges = hasDateRange(specs) ? quickRanges(today, period) : null;
  const quick = ranges && [
    { key: "today", label: t("report.range.today"), range: ranges.today },
    { key: "period", label: t("report.range.period"), range: ranges.period },
    { key: "year", label: t("report.range.year"), range: ranges.year },
  ];

  return (
    <div className="erp-row erp-report__params" role="group" aria-label={t("report.params")}>
      {specs.map((spec) => {
        const id = `report-param-${spec.name}`;
        const current = value[spec.name];
        return (
          <label key={spec.name} htmlFor={id} className="erp-field erp-field--inline">
            {spec.type !== "boolean" && <span className="erp-small">{spec.label}</span>}
            {spec.type === "date" && <input id={id} type="date" value={typeof current === "string" ? current : ""} required={spec.required} onChange={(e) => set(spec.name, e.target.value)} />}
            {spec.type === "text" && <input id={id} type="text" value={typeof current === "string" ? current : ""} required={spec.required} onChange={(e) => set(spec.name, e.target.value)} />}
            {spec.type === "boolean" && (
              <span className="erp-row">
                <input id={id} type="checkbox" checked={current === true} onChange={(e) => set(spec.name, e.target.checked ? true : undefined)} />
                <span className="erp-small">{spec.label}</span>
              </span>
            )}
            {spec.type === "number" && asSelect(spec) && (
              <select id={id} value={current === undefined || current === null ? "" : String(current)} onChange={(e) => set(spec.name, e.target.value === "" ? undefined : Number(e.target.value))}>
                {!spec.required && <option value="" />}
                {Array.from({ length: spec.max! - spec.min! + 1 }, (_, i) => spec.min! + i).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
            {spec.type === "number" && !asSelect(spec) && (
              <input id={id} type="number" min={spec.min} max={spec.max} value={current === undefined || current === null ? "" : String(current)} onChange={(e) => set(spec.name, e.target.value === "" ? undefined : Number(e.target.value))} />
            )}
            {(spec.type === "enum" || spec.type === "ref") && (
              <select id={id} value={typeof current === "string" ? current : ""} onChange={(e) => set(spec.name, e.target.value)}>
                {!spec.required && <option value="">{t("report.all")}</option>}
                {(spec.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </label>
        );
      })}
      {quick && (
        <span className="erp-row" role="group" aria-label={t("report.range.title")}>
          {quick.map(({ key, label, range }) => (
            <button key={key} type="button" className="erp-btn erp-btn--sm" onClick={() => onChange({ ...value, from: range.from, to: range.to })}>
              {label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
