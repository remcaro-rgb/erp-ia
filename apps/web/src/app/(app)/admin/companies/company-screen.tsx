"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import type { CompanyData } from "@/lib/admin/load";
import { StepUpDock, useAdminAction } from "../_components/use-admin-action";

/** The time zones the runtime knows, the company's own first when it is not among them. */
function timeZones(current: string): string[] {
  const known = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return known.includes(current) ? known : [current, ...known];
}

/** Empresa: the legal and trade names and the time zone (kernel.admin.company.update); the tax data is shown, not edited. */
export function CompanyScreen({ data }: { data: CompanyData }) {
  const t = useTranslations();
  const base = useId();
  const { perform, prompt, status, busy } = useAdminAction();
  const [legalName, setLegalName] = useState(data.legalName);
  const [tradeName, setTradeName] = useState(data.tradeName ?? "");
  const [timezone, setTimezone] = useState(data.timezone);
  const changed = legalName !== data.legalName || tradeName !== (data.tradeName ?? "") || timezone !== data.timezone;
  return (
    <section className="erp-card erp-stack" style={{ padding: 16 }}>
      <div className="erp-row">
        <h2>{t("common.admin.companies.title")}</h2>
        <span className="erp-small erp-muted">{t("common.admin.companies.hint")}</span>
      </div>
      <div className="erp-form2">
        <div className="erp-field">
          <label htmlFor={`${base}-legal`}>{t("common.admin.companies.legal_name")}</label>
          <input id={`${base}-legal`} value={legalName} maxLength={450} onChange={(e) => setLegalName(e.target.value)} />
        </div>
        <div className="erp-field">
          <label htmlFor={`${base}-trade`}>{t("common.admin.companies.trade_name")}</label>
          <input id={`${base}-trade`} value={tradeName} maxLength={450} onChange={(e) => setTradeName(e.target.value)} />
        </div>
        <div className="erp-field">
          <label htmlFor={`${base}-tax`}>{t("common.admin.companies.tax_id")}</label>
          <input id={`${base}-tax`} className="erp-mono" value={data.taxId ?? ""} disabled />
        </div>
        <div className="erp-field">
          <label htmlFor={`${base}-tz`}>
            {t("common.admin.companies.timezone")} <span className="erp-field__hint">{t("common.admin.companies.timezone_hint")}</span>
          </label>
          <select id={`${base}-tz`} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {timeZones(data.timezone).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
        <div className="erp-field">
          <label htmlFor={`${base}-country`}>{t("common.admin.companies.country")}</label>
          <input id={`${base}-country`} value={data.countryCode} disabled />
        </div>
        <div className="erp-field">
          <label htmlFor={`${base}-currency`}>{t("common.admin.companies.currency")}</label>
          <input id={`${base}-currency`} value={data.currencyCode} disabled />
        </div>
      </div>
      <div className="erp-row">
        <span className="erp-grow" />
        <button
          type="button"
          className="erp-btn erp-btn--primary"
          disabled={busy || !changed || legalName.trim() === ""}
          onClick={() => void perform("kernel.admin.company.update", { legalName, tradeName: tradeName.trim() === "" ? null : tradeName, timezone })}
        >
          {t("common.admin.companies.save")}
        </button>
      </div>
      {status}
      <StepUpDock prompt={prompt} />
    </section>
  );
}
