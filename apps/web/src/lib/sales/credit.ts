import "server-only";
import { gridPageAccess, runnableProcesses, type JwtClaims, type RunProcessDeps } from "@erp/kernel";
import { gridEntity } from "@/lib/grid/access";

// Whether a pedido's page may show the customer's credit «Disponible» (prototype 2B) to the caller. The Disponible is the credit limit less
// what the customer owes and has firmly ordered, summed from invoicing's published views (v_open_invoices, v_order_invoiced), which are not
// masked (rule 3 publishes them for processes). So the caller must see every amount they count as it is (rule 14): the credit limit of
// the customer terms, the invoices' total, company-currency total, paid, credited and debited amounts and the invoice lines' total, and may
// consult invoices (Task 20 fix round 1). Anything less hides the fact rather than letting the difference reveal a masked amount (final
// review I-2).

/** The invoice fields v_open_invoices and v_order_invoiced compute from: each must be visible to the caller. */
export const CREDIT_INVOICE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "invoicing.invoice": ["total", "total_company", "paid_amount", "credited_amount", "debited_amount"],
  "invoicing.invoice_line": ["total"],
};

export async function creditVisibleTo(deps: Pick<RunProcessDeps, "sql" | "registry">, claims: JwtClaims): Promise<boolean> {
  const terms = gridEntity(deps.registry, "sales.customer_terms");
  if (!terms) return false;
  if (((await gridPageAccess(deps.sql, claims, terms)).modes.credit_limit ?? "visible") !== "visible") return false;
  if (!(await runnableProcesses(deps.sql, deps.registry, claims, ["invoicing.invoice.consult"])).has("invoicing.invoice.consult")) return false;
  for (const [entityId, fields] of Object.entries(CREDIT_INVOICE_FIELDS)) {
    const entity = gridEntity(deps.registry, entityId);
    if (!entity) return false;
    const { modes } = await gridPageAccess(deps.sql, claims, entity);
    if (fields.some((f) => (modes[f] ?? "visible") !== "visible")) return false;
  }
  return true;
}
