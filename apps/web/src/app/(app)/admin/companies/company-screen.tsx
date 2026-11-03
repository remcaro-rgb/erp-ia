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

/**
 * Empresa: the legal and trade names, the time zone and the letterhead the PDF templates print (address, city, phone; the logo is chosen in
 * Plantillas PDF) through kernel.admin.company.update; the tax data is shown, not edited.
 */
export function CompanyScreen({ data }: { data: CompanyData }) {
  const t = useTranslations();
  const base = useId();
  const { perform, prompt, status, busy } = useAdminAction();
  const [legalName, setLegalName] = useState(data.legalName);
  const [tradeName, setTradeName] = useState(data.tradeName ?? "");
  const [timezone, setTimezone] = useState(data.timezone);
  const [addressLine, setAddressLine] = useState(data.addressLine ?? "");
  const [city, setCity] = useState(data.city ?? "");
  const [phoneCc, setPhoneCc] = useState(data.phoneCc ?? "57");
  const [phone, setPhone] = useState(data.phone ?? "");
  const letterheadChanged = addressLine !== (data.addressLine ?? "") || city !== (data.city ?? "") || phoneCc !== (data.phoneCc ?? "57") || phone !== (data.phone ?? "");
  const changed = legalName !== data.legalName || tradeName !== (data.tradeName ?? "") || timezone !== data.timezone || letterheadChanged;
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
          <label htmlFor={`${base}-address`}>
            {t("common.admin.companies.address")} <span className="erp-field__hint">{t("common.admin.companies.letterhead_hint")}</span>
          </label>
          <input id={`${base}-address`} value={addressLine} maxLength={200} onChange={(e) => setAddressLine(e.target.value)} />
        </div>
        <div className="erp-field">
          <label htmlFor={`${base}-city`}>{t("common.admin.companies.city")}</label>
          <input id={`${base}-city`} value={city} maxLength={100} onChange={(e) => setCity(e.target.value)} />
        </div>
        <div className="erp-field">
          <label htmlFor={`${base}-phone`}>{t("common.admin.companies.phone")}</label>
          <div className="erp-row">
            <input aria-label={t("common.admin.companies.phone_cc")} value={phoneCc} maxLength={4} style={{ width: 64 }} onChange={(e) => setPhoneCc(e.target.value.replace(/[^0-9]/g, ""))} />
            <input id={`${base}-phone`} className="erp-grow" value={phone} maxLength={20} inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
          </div>
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
          onClick={() =>
            void perform("kernel.admin.company.update", {
              legalName,
              tradeName: tradeName.trim() === "" ? null : tradeName,
              timezone,
              ...(letterheadChanged ? { addressLine: addressLine.trim() || null, city: city.trim() || null, phoneCc, phone: phone.trim() || null } : {}),
            })
          }
        >
          {t("common.admin.companies.save")}
        </button>
      </div>
      {status}
      <StepUpDock prompt={prompt} />
    </section>
  );
}
