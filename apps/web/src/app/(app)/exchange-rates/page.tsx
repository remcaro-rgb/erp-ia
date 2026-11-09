import { Suspense } from "react";
import { GridRoute } from "../_components/grid-route";
import { ImportOfficialRateButton } from "./import-button";
import { RateForm } from "./rate-form";

// Tasas de cambio (Núcleo › Parámetros; plan 2B.2 Task 34.1, FX §2): the core.exchange_rate grid over its masked view, newest day first.
// «Registrar tasa» writes a manual rate (core.exchange_rate.set) and, on a TRM day, offers «Reemplazar TRM» (step-up); «Traer TRM» runs
// the official-rate import now. The menu item guards the page.
export default function ExchangeRatesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <GridRoute entity="core.exchange_rate" href="/exchange-rates" toolbarExtra={
          <>
            <RateForm />
            <ImportOfficialRateButton />
          </>
        } />
    </Suspense>
  );
}
