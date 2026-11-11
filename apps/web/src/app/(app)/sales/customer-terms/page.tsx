import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { gridPageAccess } from "@erp/kernel";
import { gridEntity } from "@/lib/grid/access";
import { buildColumns } from "@/lib/grid/columns";
import { linkableEntities } from "@/lib/grid/links";
import { presentationOf } from "@/lib/grid/presentation";
import { processDeps } from "@/lib/server/runtime";
import { GridRoute } from "../../_components/grid-route";
import { mayRun, priceLists, settingsCaller } from "../../_components/sales/settings-load";
import { CustomerTermsForm } from "../../_components/sales/settings-form";

// Condiciones comerciales (plan 2B Task 14b): the customers with a price list, a standing discount or a credit limit of their own, in the
// universal grid (rule 20), and under it the form that sets a customer's (sales.customer_terms.set; it changes the ones they had).
async function TermsForm() {
  const caller = await settingsCaller();
  const deps = processDeps();
  const t = await getTranslations();
  const entity = gridEntity(deps.registry, "core.party");
  const [lists, canSave, access, linkable] = await Promise.all([
    priceLists(caller),
    mayRun(caller, "sales.customer_terms.set"),
    entity ? gridPageAccess(deps.sql, caller.claims, entity) : Promise.resolve(null),
    linkableEntities(deps, caller.claims, ["core.party"]),
  ]);
  if (!canSave) return null;
  const party = { fields: entity && access ? buildColumns(entity, access, presentationOf(entity.id), (key) => t(key)) : [], entityLabel: t("entity.core.party"), linkable: linkable.has("core.party") };
  return <CustomerTermsForm party={party} priceLists={lists} canSave={canSave} />;
}

export default function SalesCustomerTermsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <>
      <Suspense fallback={null}>
        <GridRoute entity="sales.customer_terms" href="/sales/customer-terms" />
      </Suspense>
      <Suspense fallback={null}>
        <TermsForm />
      </Suspense>
    </>
  );
}
