import { Suspense } from "react";
import { putawayPageData } from "@/lib/warehouse/screens";
import { settingsCaller } from "../../_components/sales/settings-load";
import { PutawayScreen } from "../_components/putaway-screen";

// Ubicar recibidos (Bodega › Documentos; plan 2B.2 Task 29.4, PG §4.3 step 8, owner item 239): a receipt, where each of its lines should go
// (warehouse.putaway.suggest), the destination editable, «Confirmar ubicación» (warehouse.putaway.confirm; inventory relocates the stock).
// `?movement=` opens on a receipt (the «Entrada por ubicar» recommendation links here).
async function Putaway({ searchParams }: { searchParams: Promise<{ movement?: string | string[] }> }) {
  const caller = await settingsCaller();
  const movement = (await searchParams).movement;
  return <PutawayScreen data={await putawayPageData(caller, typeof movement === "string" ? movement : null)} />;
}

export default function WarehousePutawayPage({ searchParams }: { searchParams: Promise<{ movement?: string | string[] }> }) {
  // The session cookie and the address are request data: read them inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Putaway searchParams={searchParams} />
    </Suspense>
  );
}
