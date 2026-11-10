import { defineProcess, ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { TRACKING_KINDS, type TrackingKind } from "../entities";
import { id, productFacts, qtyText, refuse } from "./common";

// Seguimiento por producto (plan 2B.2 Task 28.1, PG §3.1, item 146): how inventory tracks a product's stock. One row of
// inventory.product_tracking per product; a product without one is untracked. Switching the tracking is sensitive (step-up: it changes how
// every later movement is validated) and refused while the product has stock in any bucket (`tracking_has_stock`): the user first moves
// the stock out (an adjustment pair under step-up: out untracked, in with the lot). Changing only FEFO, expiry or block of the same
// tracking is not a switch and is allowed with stock.

const FEATURE = "inventory.stock";

/** A product's tracking as the movements read it (PG §3.1 defaults when the product has no row). */
export interface ProductTracking {
  tracking: TrackingKind;
  fefo: boolean;
  expiryRequired: boolean;
  blockExpired: boolean;
}

/** The defaults of a product without a tracking row: untracked, FEFO on, expiry not required, expired lots blocked. */
export const DEFAULT_TRACKING: ProductTracking = { tracking: "none", fefo: true, expiryRequired: false, blockExpired: true };

/** The tracking of `productId` (company RLS applies: read in the caller's transaction). */
export async function trackingOf(tx: ProcessContext["tx"], productId: string): Promise<ProductTracking> {
  const [row] = await tx<{ tracking: TrackingKind; fefo: boolean; expiry_required: boolean; block_expired: boolean }[]>`
    select tracking, fefo, expiry_required, block_expired from inventory.product_tracking where product_id = ${productId}`;
  return row ? { tracking: row.tracking, fefo: row.fefo, expiryRequired: row.expiry_required, blockExpired: row.block_expired } : { ...DEFAULT_TRACKING };
}

/** Refuses with invalid_input unless the caller can see `productId` (core.v_product_stock). */
export async function assertProduct(ctx: ProcessContext, productId: string): Promise<void> {
  const facts = await productFacts(ctx, [productId]);
  if (!facts.has(productId)) refuse("invalid_product", ["El producto no existe o no es visible"]);
}

export const productTrackingSet = defineProcess({
  id: "inventory.product_tracking.set",
  module: "inventory",
  kind: "update",
  sensitivity: "step-up",
  recordAccess: "none",
  feature: FEATURE,
  description:
    "Fija cómo se sigue un producto en el inventario: sin seguimiento, por lote o por serial, con FEFO, vencimiento obligatorio y bloqueo de lotes vencidos; no cambia el seguimiento mientras el producto tenga existencias",
  input: z.object({
    productId: id,
    tracking: z.enum(TRACKING_KINDS),
    fefo: z.boolean().optional(),
    expiryRequired: z.boolean().optional(),
    blockExpired: z.boolean().optional(),
  }).strict(),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    await assertProduct(ctx, input.productId);
    const [current] = await ctx.tx<{ id: string; tracking: TrackingKind }[]>`
      select id, tracking from inventory.product_tracking where product_id = ${input.productId} for update`;
    const before: TrackingKind = current?.tracking ?? "none";
    if (input.tracking !== before) {
      const [stock] = await ctx.tx<{ buckets: number; on_hand: string | null }[]>`
        select count(*)::int as buckets, sum(abs(on_hand))::text as on_hand from inventory.stock_levels where product_id = ${input.productId} and on_hand <> 0`;
      if ((stock?.buckets ?? 0) > 0) {
        refuse("tracking_has_stock", [
          `El producto tiene existencias (${qtyText(Number(stock!.on_hand))} en ${stock!.buckets} ${stock!.buckets === 1 ? "ubicación" : "ubicaciones"}): sácalas antes de cambiar su seguimiento`,
        ]);
      }
    }
    // A key left out keeps what the product has (a new row: the defaults).
    const given = Object.fromEntries(
      Object.entries({ tracking: input.tracking, fefo: input.fefo, expiry_required: input.expiryRequired, block_expired: input.blockExpired }).filter(([, v]) => v !== undefined),
    );
    if (current) {
      await ctx.tx`update inventory.product_tracking set ${ctx.tx(given)} where id = ${current.id}`;
      return { id: current.id };
    }
    const values = { fefo: DEFAULT_TRACKING.fefo, expiry_required: DEFAULT_TRACKING.expiryRequired, block_expired: DEFAULT_TRACKING.blockExpired, ...given };
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into inventory.product_tracking ${ctx.tx({ company_id: ctx.companyId, product_id: input.productId, ...values })} returning id`;
    return { id: row!.id };
  },
});

export const productTrackingConsult = defineProcess({
  id: "inventory.product_tracking.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta cómo se sigue un producto en el inventario (sin seguimiento, por lote o por serial) con los campos que el rol puede ver",
  input: z.object({ productId: id }).strict(),
  output: z.looseObject({ configured: z.boolean() }),
  handler: async (ctx, { productId }) => {
    await assertProduct(ctx, productId).catch((error: unknown) => {
      if (error instanceof ProcessError) throw new ProcessError("not_found", `product ${productId} not found`);
      throw error;
    });
    const [row] = await ctx.tx`select * from inventory.v_product_tracking where product_id = ${productId}`;
    return row
      ? { ...row, configured: true }
      : { configured: false, product_id: productId, tracking: DEFAULT_TRACKING.tracking, fefo: DEFAULT_TRACKING.fefo, expiry_required: DEFAULT_TRACKING.expiryRequired, block_expired: DEFAULT_TRACKING.blockExpired };
  },
});

export const TRACKING_PROCESSES = [productTrackingSet, productTrackingConsult];
