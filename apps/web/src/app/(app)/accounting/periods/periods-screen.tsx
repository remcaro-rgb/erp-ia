"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney, periodName, Pill } from "@erp/ui";
import type { PeriodSummary, YearPreview, YearSummary } from "@erp/module-accounting";
import type { PeriodsPageData } from "@/lib/accounting/periods";
import { closePeriodAction, closeYearAction, reopenPeriodAction, reopenYearAction, yearPreviewAction, type CloseCheckResult } from "@/lib/accounting/period-actions";
import { AdminDialog } from "../../admin/_components/admin-dialog";
import { useAdminAction } from "../../admin/_components/use-admin-action";

/** `2026-10-15` as `15/10/2026`. */
export const dayText = (iso: string): string => iso.split("-").reverse().join("/");

type Dialog = { kind: "close"; period: PeriodSummary } | { kind: "reopen"; period: PeriodSummary } | { kind: "close_year" | "reopen_year"; year: YearSummary } | null;

/** The year the page opens on: the earliest open one holding the latest work, else the newest. */
const startYear = (years: readonly YearSummary[]): string => (years.find((y) => y.status === "open") ?? years[0]!).id;

export function PeriodsScreen({ data }: { data: PeriodsPageData }) {
  const t = useTranslations("accounting.pages.periods");
  const tv = useTranslations("accounting.values");
  const locale = useLocale();
  const [yearId, setYearId] = useState(() => startYear(data.years));
  const [dialog, setDialog] = useState<Dialog>(null);
  const year = data.years.find((y) => y.id === yearId) ?? data.years[0]!;

  return (
    <div className="erp-stack">
      <div className="erp-row" role="group" aria-label={t("years")}>
        {data.years.map((y) => {
          const closed = y.periods.filter((p) => p.status === "closed").length;
          return (
            <button key={y.id} type="button" className={`erp-card erp-yearcard${y.id === year.id ? " erp-yearcard--on" : ""}`} aria-pressed={y.id === year.id} onClick={() => setYearId(y.id)}>
              <b>{t("year", { year: y.year })}</b>{" "}
              <Pill tone={y.status === "closed" ? "gray" : "ok"}>{tv(`period_status.${y.status}`)}</Pill>
              <div className="erp-small erp-muted">{t("closed_count", { closed, total: y.periods.length })}</div>
            </button>
          );
        })}
      </div>

      <section className="erp-card">
        <div className="erp-admin__head">
          <h2>{t("title", { year: year.year })}</h2>
          <span className="erp-grow" />
          {year.status === "open" && data.can.closeYear && (
            <button type="button" className="erp-btn" onClick={() => setDialog({ kind: "close_year", year })}>
              {t("close_year")}
            </button>
          )}
          {year.status === "closed" && data.can.reopenYear && (
            <button type="button" className="erp-btn" onClick={() => setDialog({ kind: "reopen_year", year })}>
              {t("reopen_year")}
            </button>
          )}
        </div>
        <div className="erp-admin__scroll">
          <table aria-label={t("table", { year: year.year })}>
            <thead>
              <tr>
                <th>{t("col_period")}</th>
                <th>{t("col_status")}</th>
                <th className="erp-num">{t("col_entries")}</th>
                <th className="erp-num">{t("col_debit")}</th>
                <th className="erp-num">{t("col_credit")}</th>
                <th className="erp-num">{t("col_open")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {year.periods.map((p) => (
                <tr key={p.id}>
                  <td>
                    <b>{periodName(p.startsOn, locale)}</b>
                  </td>
                  <td>
                    <Pill tone={p.status === "closed" ? "gray" : "ok"}>{tv(`period_status.${p.status}`)}</Pill>
                    {p.status === "open" && p.reopenedFor && <span className="erp-small"> {t("reopened_for", { date: dayText(p.reopenedFor) })}</span>}
                    {p.status === "open" && p.reopenedCount > 0 && !p.reopenedFor && <span className="erp-small erp-muted"> {t("reopened", { count: p.reopenedCount })}</span>}
                  </td>
                  <td className="erp-num">{p.entries}</td>
                  <td className="erp-num erp-mono">{formatMoney(p.debit)}</td>
                  <td className="erp-num erp-mono">{formatMoney(p.credit)}</td>
                  <td className="erp-num">{p.open > 0 ? <Pill tone="warn">{p.open}</Pill> : 0}</td>
                  <td>
                    {p.status === "open" && data.can.closePeriod && year.status === "open" && (
                      <button type="button" className="erp-btn erp-btn--sm" aria-label={t("close_named", { period: periodName(p.startsOn, locale) })} onClick={() => setDialog({ kind: "close", period: p })}>
                        {t("close")}
                      </button>
                    )}
                    {p.status === "closed" && data.can.reopenPeriod && year.status === "open" && (
                      <button type="button" className="erp-btn erp-btn--sm" aria-label={t("reopen_named", { period: periodName(p.startsOn, locale) })} onClick={() => setDialog({ kind: "reopen", period: p })}>
                        {t("reopen")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {dialog?.kind === "close" && <ClosePeriodDialog period={dialog.period} onClose={() => setDialog(null)} />}
      {dialog?.kind === "reopen" && <ReopenPeriodDialog period={dialog.period} today={data.today} onClose={() => setDialog(null)} />}
      {(dialog?.kind === "close_year" || dialog?.kind === "reopen_year") && <YearDialog year={dialog.year} mode={dialog.kind} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Cerrar período: the checks run under TOTP; a failed check keeps the period open and the dialog lists what failed. */
function ClosePeriodDialog({ period, onClose }: { period: PeriodSummary; onClose: () => void }) {
  const t = useTranslations("accounting.pages.periods");
  const tc = useTranslations("common");
  const tv = useTranslations("accounting.values");
  const locale = useLocale();
  const { execute, prompt, status, busy } = useAdminAction();
  const [checks, setChecks] = useState<CloseCheckResult[] | null>(null);
  const name = periodName(period.startsOn, locale);

  const run = async () => {
    const result = await execute((token) => closePeriodAction(period.id, token));
    if (!result.ok) return;
    if (result.closed) onClose();
    else setChecks(result.checks);
  };
  const failed = checks?.filter((c) => !c.passed) ?? [];

  return (
    <AdminDialog
      open
      title={t("close_title", { period: name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {tc("cancel")}
          </button>
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy} onClick={() => void run()}>
            {checks ? t("retry") : t("close_confirm")}
          </button>
        </>
      }
    >
      <p>{t("close_body")}</p>
      {period.open > 0 && <p className="erp-small erp-muted">{t("close_open_note", { count: period.open })}</p>}
      {checks && (
        <>
          <p role="alert" className="erp-field__error">
            {t("close_failed", { count: failed.length })}
          </p>
          <ul aria-label={t("checks")} className="erp-checklist">
            {checks.map((c) => (
              <li key={c.check} data-passed={c.passed}>
                <Pill tone={c.passed ? "ok" : "danger"}>{c.passed ? t("check_ok") : t("check_failed")}</Pill> <b>{tv.has(`close_check.${c.check}`) ? tv(`close_check.${c.check}`) : c.check}</b>
                {!c.passed && <div className="erp-small">{c.note}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="erp-small erp-muted">{tc("admin.process", { process: "accounting.period.close" })}</div>
      {checks ? null : status}
      {prompt}
    </AdminDialog>
  );
}

/** Reabrir período: all of it, or only one day (then only comprobantes dated that day post while it is open). */
export function ReopenPeriodDialog({ period, today, initialDay = false, onClose }: { period: Pick<PeriodSummary, "id" | "startsOn" | "endsOn">; today: string; initialDay?: boolean; onClose: () => void }) {
  const t = useTranslations("accounting.pages.periods");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { execute, prompt, status, busy } = useAdminAction();
  const [scope, setScope] = useState<"all" | "day">(initialDay ? "day" : "all");
  const inside = today >= period.startsOn && today <= period.endsOn ? today : period.startsOn;
  const [date, setDate] = useState(inside);
  const valid = scope === "all" || (date >= period.startsOn && date <= period.endsOn);

  return (
    <AdminDialog
      open
      title={t("reopen_title", { period: periodName(period.startsOn, locale) })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {tc("cancel")}
          </button>
          <button
            type="button"
            className="erp-btn erp-btn--primary"
            disabled={busy || !valid}
            onClick={() => void execute((token) => reopenPeriodAction(period.id, scope === "day" ? date : null, token)).then((r) => r.ok && onClose())}
          >
            {t("reopen_confirm")}
          </button>
        </>
      }
    >
      <fieldset className="erp-field">
        <legend className="erp-field__label">{t("reopen_scope")}</legend>
        <label className="erp-check">
          <input type="radio" name="scope" checked={scope === "all"} onChange={() => setScope("all")} /> {t("reopen_all")}
        </label>
        <label className="erp-check">
          <input type="radio" name="scope" checked={scope === "day"} onChange={() => setScope("day")} /> {t("reopen_day")}
        </label>
      </fieldset>
      {scope === "day" && (
        <div className="erp-field">
          <label htmlFor="reopen-day">{t("reopen_date")}</label>
          <input id="reopen-day" type="date" min={period.startsOn} max={period.endsOn} value={date} onChange={(e) => setDate(e.target.value)} />
          <div className="erp-small erp-muted">{t("reopen_day_hint")}</div>
        </div>
      )}
      <div className="erp-small erp-muted">{tc("admin.process", { process: "accounting.period.reopen" })}</div>
      {status}
      {prompt}
    </AdminDialog>
  );
}

/** Cerrar año / Reabrir año with the preview of what the closing entries will do. */
function YearDialog({ year, mode, onClose }: { year: YearSummary; mode: "close_year" | "reopen_year"; onClose: () => void }) {
  const t = useTranslations("accounting.pages.periods");
  const tc = useTranslations("common");
  const { execute, prompt, status, busy } = useAdminAction();
  const [preview, setPreview] = useState<YearPreview | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void yearPreviewAction(year.id).then((r) => live && setPreview(r.ok ? r.preview : null));
    return () => {
      live = false;
    };
  }, [year.id]);

  const closing = mode === "close_year";
  const blocked = closing ? preview !== undefined && preview !== null && (preview.openPeriods > 0 || preview.missingRoles.length > 0) : false;
  const run = () =>
    execute<object>((token) => (closing ? closeYearAction(year.id, token) : reopenYearAction(year.id, token))).then((r) => r.ok && onClose());

  return (
    <AdminDialog
      open
      title={t(closing ? "close_year_title" : "reopen_year_title", { year: year.year })}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {tc("cancel")}
          </button>
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy || !preview || blocked} onClick={() => void run()}>
            {t(closing ? "close_year" : "reopen_year")}
          </button>
        </>
      }
    >
      {preview === undefined && <p className="erp-muted">{tc("loading")}</p>}
      {preview === null && <p role="alert">{t("preview_unavailable")}</p>}
      {preview && closing && (
        <div className="erp-stack">
          <p>{t("close_year_body")}</p>
          <dl className="erp-kv" aria-label={t("preview")}>
            <dt>{t("preview_income")}</dt>
            <dd className="erp-mono">{formatMoney(preview.income)}</dd>
            <dt>{t("preview_expense")}</dt>
            <dd className="erp-mono">{formatMoney(preview.expense)}</dd>
            <dt>{preview.result < 0 ? t("preview_loss") : t("preview_profit")}</dt>
            <dd className="erp-mono">
              <b>{formatMoney(Math.abs(preview.result))}</b>
            </dd>
          </dl>
          {preview.openPeriods > 0 && (
            <p role="alert" className="erp-field__error">
              {t("preview_open_periods", { count: preview.openPeriods })}
            </p>
          )}
          {preview.missingRoles.length > 0 && (
            <p role="alert" className="erp-field__error">
              {t("preview_missing_roles")}
            </p>
          )}
        </div>
      )}
      {preview && !closing && (
        <div className="erp-stack">
          <p>{t("reopen_year_body")}</p>
          {preview.closingEntries.length === 0 ? (
            <p className="erp-muted">{t("preview_no_closing")}</p>
          ) : (
            <ul aria-label={t("preview_closing")}>
              {preview.closingEntries.map((e) => (
                <li key={e.id}>
                  <span className="erp-mono">{e.number ?? "—"}</span> {e.description} · <span className="erp-mono">{formatMoney(e.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="erp-small erp-muted">{tc("admin.process", { process: closing ? "accounting.year.close" : "accounting.year.reopen" })}</div>
      {status}
      {prompt}
    </AdminDialog>
  );
}
