"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { DataGrid, useTabs, type GridColumn } from "@erp/ui";
import { createInvoicesFromPendingAction } from "@/lib/invoicing/step-actions";

// «Por facturar» (plan 2B Task 20 fix round 1, rule 20): the universal grid over invoicing.pending_line (one row per shipped entrega line
// not yet on an invoice: filters, sort, pages, exports, read through its list process as the caller), with the selection column. The pedido
// and the entrega read by their numbers (sales' ids, never referenced across schemas: rule 3; the invoice that bills them links them).
// «Crear facturas» writes the Borradores of the pedidos of the lines chosen (the server reads their pedidos and runs
// invoicing.invoice.from_orders as the session's user: one per customer and currency); the first opens, a refusal shows the reasons.

export function PendingToInvoice({ title, columns }: { title: string; columns: GridColumn[] }) {
  const t = useTranslations("invoicing.pending_page");
  const te = useTranslations("errors");
  const router = useRouter();
  const openTab = useTabs((s) => s.open);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const create = async (lineIds: string[]) => {
    setBusy(true);
    setFailure(null);
    try {
      const outcome = await createInvoicesFromPendingAction(lineIds);
      if (!outcome.ok) {
        setFailure(outcome.messages.length > 0 ? outcome.messages.join(" · ") : te.has(outcome.code) ? te(outcome.code) : te("unknown"));
        return;
      }
      // Each Borrador in its own tab; the first one opens.
      for (const invoice of outcome.invoices) openTab({ title: invoice.number ?? t("draft_title"), href: `/r/invoicing.invoice/${invoice.id}`, kind: "record" });
      const first = outcome.invoices[0];
      if (first) router.push(`/r/invoicing.invoice/${first.id}`);
      else router.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="erp-form">
      <p className="erp-small erp-muted">{t("hint")}</p>
      {failure && (
        <div role="alert" className="erp-dian erp-dian--bad">
          <b>{failure}</b>
        </div>
      )}
      <DataGrid
        entity="invoicing.pending_line"
        title={title}
        columns={columns}
        selectionActions={(selected) => {
          // A line chosen stands for its pedido: «Crear facturas» invoices what is left of each pedido of the lines chosen.
          const orders = new Set(selected.map((r) => r.order_number ?? r.id)).size;
          return (
            <>
              <span className="erp-small erp-muted" role="status">
                {busy ? t("working") : t("chosen", { count: orders })}
              </span>
              <button type="button" className="erp-btn erp-btn--primary" disabled={busy || selected.length === 0} onClick={() => void create(selected.map((r) => r.id))}>
                {t("create")}
              </button>
            </>
          );
        }}
      />
    </div>
  );
}
