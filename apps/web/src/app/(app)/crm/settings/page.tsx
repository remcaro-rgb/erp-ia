import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { boxText, consultSettings, mayRun, settingsCaller } from "../../_components/sales/settings-load";
import { SalesSettingsForm } from "../../_components/sales/settings-form";

// Parámetros de CRM (plan 2B Task 14b): the line discount above which a cotización waits for approval (empty: none does) and how many days
// a new cotización is valid; read with crm.settings.consult, saved with crm.settings.update.
async function Settings() {
  const caller = await settingsCaller();
  const t = await getTranslations();
  const consulted = await consultSettings(caller, "crm.settings.consult");
  if ("denied" in consulted) {
    return (
      <div role="alert" className="erp-dian erp-dian--bad">
        {t(`grid.denied.${consulted.denied}`)}
      </div>
    );
  }
  const row = consulted.row;
  return (
    <SalesSettingsForm
      kind="crm"
      title={t("crm.settings_page.title")}
      hint={t("crm.settings_page.hint")}
      canSave={await mayRun(caller, "crm.settings.update")}
      boxes={[
        { key: "quoteApprovalDiscountPct", label: t("crm.settings_page.approval_discount"), hint: t("crm.settings_page.approval_discount_hint"), kind: "percent", nullable: true, value: boxText(row.quote_approval_discount_pct) },
        { key: "quoteValidityDays", label: t("crm.settings_page.validity_days"), kind: "days", value: boxText(row.quote_validity_days) },
      ]}
    />
  );
}

export default function CrmSettingsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Settings />
    </Suspense>
  );
}
