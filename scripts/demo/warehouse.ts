// Bodega in the demo (plan 2B.2 Task 29.4, owner item 218), written by scripts/demo/sales.ts step 12. Free of imports, so the e2e specs
// can read them.

/**
 * One storage ubicación per stocked category in Bodega Principal, each with the put-away rule of its category (priority 10): what is
 * received at Estantería A is suggested to go to its category's bin.
 */
export const BINS = [
  { code: "EST-GRA", name: "Estantería café en grano", category: "Café en grano" },
  { code: "EST-MOL", name: "Estantería café molido", category: "Café molido" },
  { code: "EST-REP", name: "Vitrina de repostería", category: "Repostería" },
  { code: "EST-ACC", name: "Estantería de accesorios", category: "Accesorios y empaques" },
] as const;

export const RULE_PRIORITY = 10;

/**
 * Bodega is enabled for Café del Norte late in the seed (after the earlier sale chain), so only the FEFO pedido of LOT_SALE is picked: its
 * alistamiento is made when it is confirmed, confirmed as proposed (20 of L-2311, 10 of L-2402), the Borrador entrega comes from it and
 * is shipped; then it is packed in one box and the empaque closed.
 */
export const PACK = { weightKg: 15.5, dimensions: "40 x 30 x 30 cm" } as const;

/**
 * A receipt after Bodega is on: 12 × «Café en grano Norte Especial 500 g» at Estantería A, put away to EST-GRA by its category's rule;
 * inventory relocates them (a relocation movement, no cost).
 */
export const PUTAWAY_RECEIPT = { reference: "OC-UBICAR-DEMO", sku: "CAF-GRA-500", qty: 12, to: "EST-GRA" } as const;
