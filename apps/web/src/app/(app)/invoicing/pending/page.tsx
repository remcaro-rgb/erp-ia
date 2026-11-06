import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { gridPageAccess, runnableProcesses } from "@erp/kernel";
import { redirectPathFor, requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { gridEntity } from "@/lib/grid/access";
import { buildColumns } from "@/lib/grid/columns";
import { presentationOf } from "@/lib/grid/presentation";
import { processDeps } from "@/lib/server/runtime";
import { PendingToInvoice } from "./pending-table";

// Por facturar (Reportes; plan 2B Task 20 and fix round 1, OD-2 manual, prototype 2B): what the entregas shipped and no invoice bills yet,
// as the universal grid (rule 20) over the invoicing.pending_line query entity (migration 0107: no price, the invoice prices the lines),
// its columns by the caller's field modes (rule 14). The user ticks lines and «Crear facturas» runs invoicing.invoice.from_orders with
// their pedidos: one Borrador per customer and currency, which then opens. A customer or product that is not ready to invoice is refused
// with the reason (rule 10).
async function Pending() {
  await connection();
  let caller;
  try {
    caller = await requireCaller();
  } catch (error) {
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  const deps = processDeps();
  const t = await getTranslations();
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, ["invoicing.invoice.from_orders"]);
  if (!runnable.has("invoicing.invoice.from_orders")) {
    return (
      <div role="alert" className="erp-dian erp-dian--bad">
        {t("grid.denied.forbidden")}
      </div>
    );
  }
  const entity = gridEntity(deps.registry, "invoicing.pending_line");
  if (!entity) {
    return (
      <div role="alert" className="erp-dian erp-dian--bad">
        {t("grid.denied.forbidden")}
      </div>
    );
  }
  const access = await gridPageAccess(deps.sql, caller.claims, entity);
  const columns = buildColumns(entity, access, presentationOf(entity.id), (key) => t(key));
  return <PendingToInvoice title={t("invoicing.pending_page.title")} columns={columns} />;
}

export default function InvoicingPendingPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Pending />
    </Suspense>
  );
}
