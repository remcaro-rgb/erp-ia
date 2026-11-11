import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { GridRoute } from "../../_components/grid-route";

// Comisiones (Documentos) (plan 2B.2 Task 30.4, Part G PG §5.5): the commission documents (COM-), one per payee and per invoice or collection,
// in the universal grid (rule 20); the record opens at /r/sales.commission/<id>. They are written and reversed only by their events, so
// the grid offers no «Nuevo» (no create process) and no import; each salesperson reads only their plans' commissions (record rule of 0156).
async function Intro() {
  const t = await getTranslations("sales.commission");
  return <p className="erp-small erp-muted">{t("intro")}</p>;
}

export default function SalesCommissionsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <>
      <Suspense fallback={null}>
        <Intro />
      </Suspense>
      <Suspense fallback={null}>
        <GridRoute entity="sales.commission" href="/sales/commissions" />
      </Suspense>
    </>
  );
}
