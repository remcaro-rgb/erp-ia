// The lots and serials of the demo (plan 2B.2 Task 28.4, Part G design PG §3.5, §3.6), written by scripts/demo/sales.ts step 2. Free of
// imports, so the e2e specs can read them.

/**
 * «Café molido tradicional 500 g» is followed by lot (FEFO): it starts with two lots received through inventory.movement.post instead of the
 * opening stock, L-2311 expiring first (20 units) and L-2402 later (80). The expiries are days from the seed's today, so the lots never
 * expire under the demo.
 */
export const LOT_PRODUCT = {
  sku: "CAF-MOL-500",
  reference: "OC-LOTES-DEMO",
  lots: [
    { code: "L-2311", expiresInDays: 45, qty: 20 },
    { code: "L-2402", expiresInDays: 150, qty: 80 },
  ],
} as const;

/** The grinder is followed by serial: three serials received one by one. */
export const SERIAL_PRODUCT = {
  sku: "ACC-MOL-ELE",
  reference: "OC-SERIALES-DEMO",
  serials: ["MOL-0001", "MOL-0002", "MOL-0003"],
} as const;

/**
 * The sale that leaves by FEFO in two lots: 30 × «Café molido tradicional 500 g» to Distribuciones Andinas del Café, shipped (20 of L-2311,
 * 10 of L-2402) and invoiced as a Borrador whose line carries both lots. «Trazabilidad de lotes» of L-2311 lists this customer.
 */
export const LOT_SALE = {
  notes: "Demostración: entrega que sale por FEFO en dos lotes",
  party: "901642753",
  partyName: "Distribuciones Andinas del Café S.A.S.",
  qty: 30,
  split: [
    { code: "L-2311", qty: 20 },
    { code: "L-2402", qty: 10 },
  ],
} as const;
