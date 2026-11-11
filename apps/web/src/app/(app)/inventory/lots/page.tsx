import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { GridRoute } from "../../_components/grid-route";

// Lotes (Maestros) (plan 2B.2 Task 28.1): the lots of every lot-tracked product, in the universal grid (rule 20); a receipt creates them (28.2).
async function Intro() {
  const t = await getTranslations("inventory.lot");
  return <p className="erp-small erp-muted">{t("intro")}</p>;
}

export default function InventoryLotsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <>
      <Suspense fallback={null}>
        <Intro />
      </Suspense>
      <Suspense fallback={null}>
        <GridRoute entity="inventory.lot" href="/inventory/lots" />
      </Suspense>
    </>
  );
}
