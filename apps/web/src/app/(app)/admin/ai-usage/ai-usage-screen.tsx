"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { AiUsage } from "@erp/kernel";
import { ShareMeter } from "@erp/ui";

/**
 * Uso de IA (rule 27, design §20.2): the month's tokens against the company's allowance with its meter (ticks at 80 % and
 * 100 %, the percentage written, the cap said in words), the estimated cost, and the breakdown per user and per model.
 * Above the allowance the assistant answers without the model.
 */
export function AiUsageScreen({ data }: { data: AiUsage }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const tokens = new Intl.NumberFormat(locale);
  // Fixed decimals, so a column of costs aligns on the decimal separator.
  const usd = new Intl.NumberFormat(locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  // A cap of zero is already reached, whatever was used.
  const share = data.limit === null ? 0 : data.limit === 0 ? 1 : data.used / data.limit;
  const over = data.limit !== null && data.used >= data.limit;
  const task = (key: string) => (t.has(`common.admin.ai_usage.tasks.${key}`) ? t(`common.admin.ai_usage.tasks.${key}`) : key);

  return (
    <div className="erp-stack">
      <div className="erp-row">
        <span className="erp-small erp-muted">{t("common.admin.ai_usage.hint")}</span>
        <span className="erp-grow" />
        <label className="erp-small" htmlFor="ai-usage-month">
          {t("common.admin.ai_usage.month")}
        </label>
        <input id="ai-usage-month" type="month" value={data.month} onChange={(e) => e.target.value && router.push(`/admin/ai-usage?month=${e.target.value}`)} />
      </div>
      <div className="erp-kpis">
        <div className="erp-card erp-kpi">
          <span className="erp-kpi__label">{t("common.admin.ai_usage.tokens_month")}</span>
          <span className="erp-kpi__value">{tokens.format(data.used)}</span>
          {data.limit !== null && (
            <>
              <ShareMeter value={share} label={t("common.admin.ai_usage.bar")} />
              <span className={over ? "erp-pill erp-pill--danger erp-num" : share >= 0.8 ? "erp-pill erp-pill--warn erp-num" : "erp-small erp-muted erp-num"}>
                <b>{percent.format(share)}</b>
                {over ? ` · ${t("common.admin.ai_usage.cap_reached")}` : ""}
              </span>
            </>
          )}
          <span className="erp-small erp-muted">
            {data.limit !== null ? `${t("common.admin.ai_usage.of_limit", { limit: tokens.format(data.limit) })} · ${t("common.admin.ai_usage.warn_at")}` : t("common.admin.ai_usage.no_limit")}
          </span>
        </div>
        <div className="erp-card erp-kpi">
          <span className="erp-kpi__label">{t("common.admin.ai_usage.cost")}</span>
          <span className="erp-kpi__value">{t("common.admin.ai_usage.cost_value", { amount: usd.format(data.costUsd) })}</span>
        </div>
        <div className="erp-card erp-kpi">
          <span className="erp-kpi__label">{t("common.admin.ai_usage.limit")}</span>
          <span className="erp-kpi__value">{data.limit !== null ? tokens.format(data.limit) : t("common.admin.ai_usage.limit_none")}</span>
          <span className="erp-small erp-muted">{t("common.admin.ai_usage.limit_note")}</span>
        </div>
      </div>
      <section className="erp-card">
        <div className="erp-admin__head">
          <h2>{t("common.admin.ai_usage.per_user")}</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>{t("common.admin.ai_usage.col_user")}</th>
              <th className="erp-num">{t("common.admin.ai_usage.col_calls")}</th>
              <th className="erp-num">{t("common.admin.ai_usage.col_tokens")}</th>
              <th className="erp-num">{t("common.admin.ai_usage.col_cost")}</th>
            </tr>
          </thead>
          <tbody>
            {data.users.length === 0 ? (
              <tr>
                <td colSpan={4} className="erp-muted">
                  {t("common.admin.ai_usage.empty")}
                </td>
              </tr>
            ) : (
              data.users.map((user) => (
                <tr key={user.userId ?? "platform"}>
                  <td>
                    {user.name ?? user.email ?? t("common.admin.ai_usage.platform")} {user.email && <span className="erp-small erp-muted erp-mono">{user.email}</span>}
                  </td>
                  <td className="erp-num">{tokens.format(user.calls)}</td>
                  <td className="erp-num">{tokens.format(user.tokens)}</td>
                  <td className="erp-num">{usd.format(user.costUsd)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      <section className="erp-card">
        <div className="erp-admin__head">
          <h2>{t("common.admin.ai_usage.per_model")}</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>{t("common.admin.ai_usage.col_task")}</th>
              <th>{t("common.admin.ai_usage.col_model")}</th>
              <th className="erp-num">{t("common.admin.ai_usage.col_calls")}</th>
              <th className="erp-num">{t("common.admin.ai_usage.col_tokens")}</th>
              <th className="erp-num">{t("common.admin.ai_usage.col_cost")}</th>
            </tr>
          </thead>
          <tbody>
            {data.models.length === 0 ? (
              <tr>
                <td colSpan={5} className="erp-muted">
                  {t("common.admin.ai_usage.empty")}
                </td>
              </tr>
            ) : (
              data.models.map((model) => (
                <tr key={`${model.task}:${model.model}`}>
                  <td>{task(model.task)}</td>
                  <td className="erp-mono erp-small">{model.model}</td>
                  <td className="erp-num">{tokens.format(model.calls)}</td>
                  <td className="erp-num">{tokens.format(model.tokens)}</td>
                  <td className="erp-num">{usd.format(model.costUsd)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
