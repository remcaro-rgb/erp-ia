import { ProcessError, type ProcessContext } from "@erp/kernel";

/**
 * A refusal whose message leads with its code, the accounting convention (the engine and the consumers read the code from it): the
 * first detail follows the code, `details` lists every one.
 */
export function refuse(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_input", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

/**
 * The company's costing run lock: movement.cost, landed costs and their voids serialize on it, because all of them write the cost layers
 * and the cost events in the order they were committed (same key as movement.cost's feed lock).
 */
export const feedLockKey = (companyId: string): string => `costing.feed:${companyId}`;

/** Who fixes a product moved without a known cost: whoever may post an inventory adjustment (the fix the recommendation names). */
export const COST_MISSING_AUDIENCE = "inventory.adjustment.post";

/**
 * Raises (or merges into) the kernel recommendation of an open cost_missing row (owner item 36, plan 2B Task 38): about that row, its
 * product and bodega named by the fields they show (masked per viewer), with the row's count of uncosted movements. Costing writes only
 * through ctx.recommendations; the names are read from the owning modules' published masked views (as the system user of the run).
 */
export async function raiseCostMissing(ctx: ProcessContext, missing: { id: string; productId: string; warehouseId: string; occurrences: number }): Promise<void> {
  const [names] = await ctx.tx<{ product: string | null; warehouse: string | null }[]>`
    select (select p.description from core.v_products p where p.id = ${missing.productId}) as product,
           (select w.name from inventory.v_warehouses w where w.id = ${missing.warehouseId}) as warehouse`;
  await ctx.recommendations?.raise({
    audienceProcess: COST_MISSING_AUDIENCE,
    subject: { entity: "costing.cost_missing", id: missing.id },
    reason: "cost_missing",
    titleKey: "costing.recommendation.cost_missing.title",
    bodyKey: "costing.recommendation.cost_missing.body",
    params: {
      product: { value: names?.product?.slice(0, 200) ?? null, entity: "core.product", field: "description" },
      warehouse: { value: names?.warehouse?.slice(0, 200) ?? null, entity: "inventory.warehouse", field: "name" },
      count: { value: missing.occurrences },
    },
  });
}

/** Closes the recommendation of a cost_missing row that was just resolved (its cause is fixed). */
export async function closeCostMissing(ctx: ProcessContext, missingId: string): Promise<void> {
  await ctx.recommendations?.close({ subject: { entity: "costing.cost_missing", id: missingId }, reason: "cost_missing" });
}
