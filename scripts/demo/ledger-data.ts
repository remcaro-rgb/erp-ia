// The demo ledger's receivable and payable history (scripts/demo/accounting.ts posts it): data only, no imports, so the accounting
// module's integration tests can replay it (plan 2B Task 22, «both agree on the demo ledger»).

export const DEMO_YEAR = 2026;
export const LEDGER_STARTS_ON = `${DEMO_YEAR}-01-01`;

/** Customers the invoices go to (all in scripts/demo/data.ts). */
export const EXITO = "890900608";
export const COLINA = "900456781";
export const HOTEL_CUMBRE = "860512347";
export const CARIBE_EXPRESS = "900888123";
export const SOL_DEL_CARIBE = "890112233";
export const CATERING_ANDES = "900667788";
export const ANDINAS = "901642753";
export const BOSQUE = "900531642";
/** Suppliers on the accounts payable. */
export const TRILLADORA = "900135791";
export const TOSTADORA = "900246802";
export const ELECTRIC = "900975310";

/** The bank that pays the savings account's interest: the tercero of the 421005 sample line (exógena 1007 refuses an income with none). */
export const BANCOLOMBIA = "890903938";

export const OPENING_LINES = [
  { accountCode: "110505", debit: 5_000_000 },
  { accountCode: "11100502", debit: 80_000_000 },
  { accountCode: "11100501", debit: 15_000_000 },
  { accountCode: "130505", partyDocument: EXITO, debit: 40_000_000, dueDate: `${DEMO_YEAR}-01-31` },
  { accountCode: "130505", partyDocument: COLINA, debit: 12_000_000, dueDate: `${DEMO_YEAR}-01-31` },
  { accountCode: "143505", debit: 60_000_000 },
  { accountCode: "220505", partyDocument: TRILLADORA, credit: 18_000_000 },
  { accountCode: "220505", partyDocument: TOSTADORA, credit: 12_000_000 },
  { accountCode: "310505", credit: 100_000_000 },
  { accountCode: "370505", credit: 82_000_000 },
];

export interface InvoiceSpec {
  number: string;
  date: string;
  customer: string;
  beverages: number;
  food: number;
  costCenter: string;
  businessUnit: string;
  /** Receipt: days after the invoice, the share of it collected (1 = all), and how it was paid. */
  receipt?: { days: number; share?: number; method: "transfer" | "cash" };
}

export const INVOICES: InvoiceSpec[] = [
  { number: "FE-1001", date: "2026-01-12", customer: EXITO, beverages: 8_000_000, food: 4_000_000, costCenter: "TOS", businessUnit: "INS-DIS", receipt: { days: 26, method: "transfer" } },
  { number: "FE-1002", date: "2026-01-26", customer: HOTEL_CUMBRE, beverages: 3_000_000, food: 2_000_000, costCenter: "TOS", businessUnit: "INS-HOR", receipt: { days: 29, method: "transfer" } },
  { number: "FE-1003", date: "2026-02-09", customer: COLINA, beverages: 6_000_000, food: 3_000_000, costCenter: "TOS", businessUnit: "INS-DIS", receipt: { days: 24, method: "transfer" } },
  { number: "FE-1004", date: "2026-02-23", customer: CATERING_ANDES, beverages: 2_500_000, food: 1_500_000, costCenter: "CHA", businessUnit: "INS-HOR", receipt: { days: 20, method: "cash" } },
  { number: "FE-1005", date: "2026-03-10", customer: EXITO, beverages: 9_000_000, food: 5_000_000, costCenter: "TOS", businessUnit: "INS-DIS", receipt: { days: 28, method: "transfer" } },
  { number: "FE-1006", date: "2026-03-24", customer: SOL_DEL_CARIBE, beverages: 4_000_000, food: 3_000_000, costCenter: "TOS", businessUnit: "INS-HOR", receipt: { days: 27, method: "transfer" } },
  { number: "FE-1007", date: "2026-04-13", customer: ANDINAS, beverages: 7_000_000, food: 2_000_000, costCenter: "TOS", businessUnit: "INS-DIS", receipt: { days: 25, method: "transfer" } },
  // Never collected: more than 90 days overdue in the aging report.
  { number: "FE-1008", date: "2026-05-11", customer: COLINA, beverages: 5_000_000, food: 2_500_000, costCenter: "TOS", businessUnit: "INS-DIS" },
  { number: "FE-1009", date: "2026-06-15", customer: EXITO, beverages: 10_000_000, food: 4_000_000, costCenter: "TOS", businessUnit: "INS-DIS", receipt: { days: 30, method: "transfer" } },
  { number: "FE-1010", date: "2026-07-13", customer: BOSQUE, beverages: 3_500_000, food: 2_500_000, costCenter: "USA", businessUnit: "CON-TIE", receipt: { days: 21, method: "cash" } },
  { number: "FE-1011", date: "2026-08-10", customer: CARIBE_EXPRESS, beverages: 6_000_000, food: 2_000_000, costCenter: "TOS", businessUnit: "INS-DIS", receipt: { days: 26, method: "transfer" } },
  // Half collected: the rest is 1 to 30 days overdue.
  { number: "FE-1012", date: "2026-09-14", customer: EXITO, beverages: 11_000_000, food: 4_000_000, costCenter: "TOS", businessUnit: "INS-DIS", receipt: { days: 27, share: 0.5, method: "transfer" } },
  // Collected, then the receipt is voided: open again.
  { number: "FE-1013", date: "2026-10-05", customer: BOSQUE, beverages: 3_000_000, food: 2_000_000, costCenter: "CHA", businessUnit: "CON-WEB", receipt: { days: 14, method: "transfer" } },
  { number: "FE-1014", date: "2026-10-12", customer: COLINA, beverages: 6_000_000, food: 3_000_000, costCenter: "TOS", businessUnit: "INS-DIS" },
  // Issued and voided in the same month.
  { number: "FE-1015", date: "2026-10-19", customer: SOL_DEL_CARIBE, beverages: 2_000_000, food: 1_000_000, costCenter: "USA", businessUnit: "INS-HOR" },
];

/** Credit notes of annulment (Task 53.3): the full note a void of the invoice emits; numbered after the partial credit notes below. */
export const ANNULMENT_NOTES = [
  { number: "NC-303", date: "2026-10-20", invoice: "FE-1015" },
];

export const CREDIT_NOTES = [
  { number: "NC-301", date: "2026-06-20", customer: EXITO, subtotal: 1_000_000, costCenter: "TOS" },
  { number: "NC-302", date: "2026-09-22", customer: COLINA, subtotal: 500_000, costCenter: "TOS" },
];
