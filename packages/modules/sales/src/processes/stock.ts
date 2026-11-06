import type { ProcessContext } from "@erp/kernel";

// What the entregas and devoluciones of sales read of inventory's stock (plan 2B Task 14): only inventory's published functions
// (migration 0087, rule 3), under one lock per bodega and product that every ship and every Anular of a received devolución takes, so two of
// them on the same product queue and the second reads what the first left.

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

/** A quantity as Spanish copy prints it (4 decimals at most), the same form inventory's refusals use. */
export const qtyText = (n: number): string => n.toLocaleString("es-CO", { maximumFractionDigits: 4 });

/** Takes the per bodega and product stock lock of sales (ascending product order: two writers never wait on each other in a cycle). */
export async function lockShipStock(ctx: ProcessContext, warehouseId: string, productIds: readonly string[]): Promise<void> {
  for (const productId of [...new Set(productIds)].sort()) {
    await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`sales.ship:${ctx.companyId}:${warehouseId}:${productId}`}, 0))`;
  }
}

/** Per order line and product, the entregas of the bodega already shipped whose stock inventory has not issued yet (except `exceptId`). */
export async function pendingShipped(ctx: ProcessContext, warehouseId: string, productIds: readonly string[], exceptId: string | null) {
  const rows = await ctx.tx<{ order_line_id: string; product_id: string; qty: string }[]>`
    select l.order_line_id, l.product_id, sum(l.qty)::text as qty
    from sales.delivery_lines l join sales.deliveries d on d.id = l.delivery_id
    where d.company_id = ${ctx.companyId} and d.warehouse_id = ${warehouseId} and d.stage = 'shipped' and d.status <> 'voided'
      and l.stock_posted_at is null and l.product_id = any(${[...productIds]}::uuid[]) and d.id is distinct from ${exceptId}::uuid
    group by l.order_line_id, l.product_id`;
  return rows.map((r) => ({ orderLineId: r.order_line_id, productId: r.product_id, qty: num(r.qty) }));
}
