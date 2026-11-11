import { Suspense } from "react";
import { rulesPageData } from "@/lib/warehouse/screens";
import { settingsCaller } from "../../_components/sales/settings-load";
import { PutawayRulesEditor } from "../_components/rules-editor";

// Reglas de ubicación (Bodega › Parámetros; plan 2B.2 Task 29.3/29.4, PG §4.3 step 8): per bodega, where the goods of a category (or any
// goods) are stored, the lowest priority first; created, changed and deleted with warehouse.putaway_rule.*. Read as the caller (the menu
// shows the page only to a caller entitled to Bodega who may run those processes).
async function Rules() {
  const caller = await settingsCaller();
  return <PutawayRulesEditor data={await rulesPageData(caller)} />;
}

export default function WarehousePutawayRulesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Rules />
    </Suspense>
  );
}
