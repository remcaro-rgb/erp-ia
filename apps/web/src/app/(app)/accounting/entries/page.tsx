import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { entryQuickFilters } from "@/lib/accounting/entries-page";
import { GridRoute } from "../../_components/grid-route";
import { FromTemplateButton } from "./from-template";

// Comprobantes (accounting design §8): the grid of entries with Nuevo, Nuevo desde plantilla and the quick filters Hoy · Este período
// · Borradores · Por aprobar · Automáticos · Manuales. A row opens the comprobante in its record frame.
async function Entries() {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  let quick;
  try {
    quick = await entryQuickFilters(await requireCaller());
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  return <GridRoute entity="accounting.entry" href="/accounting/entries" quickFilters={quick.filters} {...(quick.canTemplate ? { toolbarExtra: <FromTemplateButton /> } : {})} />;
}

export default function EntriesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Entries />
    </Suspense>
  );
}
