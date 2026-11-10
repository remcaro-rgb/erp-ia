import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { GridRoute } from "../../_components/grid-route";

// Planes de comisión (Maestros) (plan 2B.2 Task 30.1, Part G PG §5.5): who earns a commission, at what rate and on whose pedidos, in the
// universal grid (rule 20); the record opens at /r/sales.commission_plan/<id>. Each salesperson reads only the plans that name them.
async function Intro() {
  const t = await getTranslations("sales.commission_plan");
  return <p className="erp-small erp-muted">{t("intro")}</p>;
}

export default function SalesCommissionPlansPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <>
      <Suspense fallback={null}>
        <Intro />
      </Suspense>
      <Suspense fallback={null}>
        <GridRoute entity="sales.commission_plan" href="/sales/commission-plans" />
      </Suspense>
    </>
  );
}
