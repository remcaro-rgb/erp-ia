import "server-only";
import { gridPageAccess, runnableProcesses, type JwtClaims, type RunProcessDeps } from "@erp/kernel";
import { gridEntity } from "@/lib/grid/access";

// Whether a pedido's page may show the customer's credit «Disponible» (prototype 2B) to the caller. The Disponible is the credit limit less
// what the customer owes and has firmly ordered, summed from invoicing's published views (v_open_invoices, v_order_invoiced), which are not
// masked (rule 3 publishes them for processes). So the caller must see every amount they count as it is (rule 14): the credit limit of
// the customer terms, the invoices' total, company-currency total, paid, credited and debited amounts and the invoice lines' total, and may
// consult invoices (Task 20 fix round 1), and may run sales.order.reassign so the orders counted are all of them (review F-4.2). Anything less hides the fact rather than letting the difference reveal a masked amount (final
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
  // `sales.v_orders` shows a salesperson only their own orders (owner scope, 0139) unless they may run `sales.order.reassign`; without it the
  // sum would leave out other salespeople's firm orders and disagree with the approval check (`sales.credit_exposure`): hide, never be wrong.
  const runnable = await runnableProcesses(deps.sql, deps.registry, claims, ["invoicing.invoice.consult", "sales.order.reassign"]);
  if (!runnable.has("invoicing.invoice.consult") || !runnable.has("sales.order.reassign")) return false;
  for (const [entityId, fields] of Object.entries(CREDIT_INVOICE_FIELDS)) {
    const entity = gridEntity(deps.registry, entityId);
    if (!entity) return false;
    const { modes } = await gridPageAccess(deps.sql, claims, entity);
    if (fields.some((f) => (modes[f] ?? "visible") !== "visible")) return false;
  }
  return true;
}
