import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { GridRoute } from "../../_components/grid-route";
import type { QuickFilter } from "../../_components/grid-page";

// Facturas (Documentos; plan 2B Task 20, prototype 2B): the sale invoices through their masked view, with the quick filters by stage
// (Borrador · Emitida · Pagada · Anulada: an annulled invoice keeps its posted status, so the stage is what reads) and by the DIAN's answer
// (Rechazada), exports and Imprimir; Nuevo writes one by hand and «Crear factura desde pedidos» opens «Por facturar». No Importar: a DIAN
// document is issued, never loaded. The record opens at /r/invoicing.invoice/<id>.
async function Invoices() {
  await connection();
  const t = await getTranslations("invoicing.grid");
  const quick: QuickFilter[] = [
    ...(["draft", "issued", "paid", "voided"] as const).map((stage) => ({ id: stage, group: "stage", label: t(`stage_${stage}`), filters: [{ field: "stage", op: "eq" as const, value: stage }] })),
    { id: "rejected", group: "dian", label: t("dian_rejected"), filters: [{ field: "dian_status", op: "eq", value: "rejected" }] },
  ];
  return (
    <GridRoute
      entity="invoicing.invoice"
      href="/invoicing/invoices"
      quickFilters={quick}
      toolbarExtra={
        <Link className="erp-btn" href="/invoicing/pending">
          {t("from_orders")}
        </Link>
      }
    />
  );
}

export default function InvoicingInvoicesPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Invoices />
    </Suspense>
  );
}
