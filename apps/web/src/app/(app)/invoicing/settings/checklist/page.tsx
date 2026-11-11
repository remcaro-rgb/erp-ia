import { Suspense } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import { withClaims } from "@erp/kernel";
import { callerIsCompanyAdmin } from "@/lib/admin/company-admin";
import { checklistView, type ChecklistConsult } from "@/lib/invoicing/checklist-view";
import { processDeps } from "@/lib/server/runtime";
import { consultSettings, settingsCaller } from "../../../_components/sales/settings-load";
import { ChecklistForm } from "./checklist-form";

// Parámetros › Facturación electrónica › Lista de verificación DIAN (plan 2B Task 35, R35-11): the values the documents carry that the DIAN may
// still ask to change, one row each, ticked by the company's administrator once verified in the DIAN's habilitación; with all of them ticked the
// defaults are confirmed, which producción needs. Only the company's administrators open it (the same guard as the settings page); every tick and
// the confirmation ask for the verification code. No menu item: it is reached from Conexión DIAN.
async function Checklist() {
  const caller = await settingsCaller();
  const t = await getTranslations();
  const deps = processDeps();
  // The company's timezone governs the dates shown (rule 8).
  const { admin, timeZone } = await withClaims(deps.sql, caller.claims, async (tx) => {
    const [company] = await tx<{ timezone: string | null }[]>`select timezone from kernel.v_companies where id = kernel.current_company_id()`;
    return { admin: await callerIsCompanyAdmin(tx), timeZone: company?.timezone ?? undefined };
  });
  if (!admin) {
    return (
      <div role="alert" className="erp-dian erp-dian--bad">
        {t("invoicing.dian_checklist.admins_only")}
      </div>
    );
  }
  const consulted = await consultSettings(caller, "invoicing.dian_checklist.consult");
  if ("denied" in consulted) {
    return (
      <div role="alert" className="erp-dian erp-dian--bad">
        {t(`grid.denied.${consulted.denied}`)}
      </div>
    );
  }
  const view = checklistView(consulted.row as unknown as ChecklistConsult, await getLocale());
  return <ChecklistForm view={view} timeZone={timeZone} />;
}

export default function DianChecklistPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Checklist />
    </Suspense>
  );
}
