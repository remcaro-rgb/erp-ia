// The figures of the demo's export sale (plan 2B.2 Task 34.8), with no imports: scripts/demo/sales.ts seeds them and the seed test and
// apps/web/e2e/foreign-currency.spec.ts read them (the web typecheck must not pull the seed's database code).

/**
 * The export sale in dollars (plan 2B.2 Task 34.8, FX §9; items 19, 56): Northwind Roasters LLC (fictional), United States, documento de
 * identificación extranjero (42); the price list «Exportación USD» (Café en grano Norte Especial · kilo at USD 25,00) named in its terms;
 * the USD rates of the last days, typed in Tasas de cambio (manual rows, origin ui: the demo calls no TRM feed); «Transferencia USD» into its
 * own dollar account (Task 34.8b, the method's «Contabilidad» tab); FE-USD: 500 kg = USD 12.500,00, IVA exento por exportación (the pack's tax
 * engine, Task 34.8a), at the TRM of its date, 4.123,45; and a partial receipt of USD 5.000 at a lower bank rate, 4.050,00, that leaves
 * USD 7.500 open and posts a realized loss of 5.000 × (4.123,45 − 4.050,00) = $ 367.250,00.
 */
export const NORTHWIND = {
  documentType: "42", documentNumber: "NWR884120", legalName: "Northwind Roasters LLC", countryCode: "US",
  addressLine: "1200 Western Ave, Seattle WA 98101", invoiceEmail: "ap@northwind-roasters.example",
} as const;
export const USD_PRICE_LIST = { name: "Exportación USD", currencyCode: "USD", sku: "CAF-GRA-KG", price: 25 } as const;
/** Pesos per dollar by days before today (today last): what Tasas de cambio lists. */
export const USD_RATES = [{ daysAgo: 2, rate: 4098.2 }, { daysAgo: 1, rate: 4110.75 }, { daysAgo: 0, rate: 4123.45 }] as const;
export const USD_METHOD = { code: "TRF-USD", name: "Transferencia USD", kind: "transfer", meansCode: "47", currency: "USD" } as const;
/** The dollar account: an auxiliary of 111010 Bancos · Moneda extranjera. */
export const USD_BANK = { code: "11101001", name: "Bancolombia cuenta de compensación USD" } as const;
export const FOREIGN_SALE = {
  notes: "Demostración: exportación en dólares a Northwind Roasters",
  qty: 500, total: 12_500, rate: 4123.45,
  receipt: { amount: 5_000, rate: 4050, reference: "SWIFT-NW-DEMO-01" },
  open: 7_500, realizedLoss: 367_250,
} as const;
