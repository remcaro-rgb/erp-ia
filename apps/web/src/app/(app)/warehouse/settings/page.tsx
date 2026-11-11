import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { consultSettings, mayRun, settingsCaller } from "../../_components/sales/settings-load";
import { WarehouseSettingsForm } from "../_components/settings-form";

// Configuración de bodega (Bodega › Parámetros; plan 2B.2 Task 29.4, PG §4.2, §4.4): whether a confirmed pedido makes its alistamiento by
// itself and whether a confirmed alistamiento asks for the Borrador entrega; read with warehouse.settings.consult, saved with
// warehouse.settings.update (an admin process: step-up, rule 15).
async function Settings() {
  const caller = await settingsCaller();
  const t = await getTranslations("grid.denied");
  const consulted = await consultSettings(caller, "warehouse.settings.consult");
  if ("denied" in consulted) {
    return (
      <div role="alert" className="erp-dian erp-dian--bad">
        {t(consulted.denied)}
      </div>
    );
  }
  const row = consulted.row;
  return <WarehouseSettingsForm autoPickOnConfirm={row.autoPickOnConfirm !== false} deliveryFromPick={row.deliveryFromPick !== false} canSave={await mayRun(caller, "warehouse.settings.update")} />;
}

export default function WarehouseSettingsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Settings />
    </Suspense>
  );
}
