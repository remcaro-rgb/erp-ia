import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { boxText, consultSettings, mayRun, priceLists, settingsCaller } from "../../_components/sales/settings-load";
import { SalesSettingsForm } from "../../_components/sales/settings-form";

// Parámetros de ventas (plan 2B Task 14b): the price list that prices a line whose customer has none of their own, and the line discount
// above which a pedido waits for approval; read with sales.settings.consult, saved with sales.settings.update.
async function Settings() {
  const caller = await settingsCaller();
  const t = await getTranslations();
  const consulted = await consultSettings(caller, "sales.settings.consult");
  if ("denied" in consulted) {
    return (
      <div role="alert" className="erp-dian erp-dian--bad">
        {t(`grid.denied.${consulted.denied}`)}
      </div>
    );
  }
  const row = consulted.row;
  const [lists, canSave] = await Promise.all([priceLists(caller), mayRun(caller, "sales.settings.update")]);
  return (
    <SalesSettingsForm
      kind="sales"
      title={t("sales.settings_page.title")}
      hint={t("sales.settings_page.hint")}
      canSave={canSave}
      boxes={[
        { key: "defaultPriceListId", label: t("sales.settings_page.default_price_list"), hint: t("sales.settings_page.default_price_list_hint"), kind: "select", nullable: true, options: lists, value: typeof row.default_price_list_id === "string" ? row.default_price_list_id : "" },
        { key: "orderApprovalDiscountPct", label: t("sales.settings_page.approval_discount"), hint: t("sales.settings_page.approval_discount_hint"), kind: "percent", nullable: true, value: boxText(row.order_approval_discount_pct) },
      ]}
    />
  );
}

export default function SalesSettingsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Settings />
    </Suspense>
  );
}
