import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { GridRoute } from "../../_components/grid-route";

// Seguimiento por producto (Parámetros) (plan 2B.2 Task 28.1): how each product is tracked; inventory.product_tracking.set (step-up) changes it.
async function Intro() {
  const t = await getTranslations("inventory.tracking");
  return <p className="erp-small erp-muted">{t("intro")}</p>;
}

export default function InventoryProductTrackingPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <>
      <Suspense fallback={null}>
        <Intro />
      </Suspense>
      <Suspense fallback={null}>
        <GridRoute entity="inventory.product_tracking" href="/inventory/product-tracking" />
      </Suspense>
    </>
  );
}
