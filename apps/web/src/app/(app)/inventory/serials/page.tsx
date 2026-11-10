import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { GridRoute } from "../../_components/grid-route";

// Seriales (Maestros) (plan 2B.2 Task 28.1): the serials of every serial-tracked product; their status is kept by the movements.
async function Intro() {
  const t = await getTranslations("inventory.serial");
  return <p className="erp-small erp-muted">{t("intro")}</p>;
}

export default function InventorySerialsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <>
      <Suspense fallback={null}>
        <Intro />
      </Suspense>
      <Suspense fallback={null}>
        <GridRoute entity="inventory.serial" href="/inventory/serials" />
      </Suspense>
    </>
  );
}
