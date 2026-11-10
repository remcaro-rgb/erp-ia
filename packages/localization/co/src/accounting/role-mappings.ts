/** The account each role resolves to by default (accounting design §5.9); a dimension narrows the mapping (§4.2). */
export const defaultRoleMappings = (): { role: string; dimension?: string; code: string }[] => [
  { role: "cash", code: "110505" },
  // A recibo de caja debits the account of its medio de pago's kind (payment_method:<kind>, plan 2B Task 21): cash and cheques to the caja,
  // transfers and cards to the bank; a receipt of a kind not mapped here (other) is refused. To confirm with the owner's accountant (migration 0110 backfills seeded charts).
  { role: "cash", dimension: "payment_method:cash", code: "110505" },
  { role: "cash", dimension: "payment_method:transfer", code: "111005" },
  { role: "cash", dimension: "payment_method:card", code: "111005" },
  { role: "cash", dimension: "payment_method:check", code: "110505" },
  { role: "bank", code: "111005" },
  { role: "receivable", code: "130505" },
  { role: "customer_advances", code: "280505" },
  { role: "revenue", code: "413595" },
  { role: "sales_returns", code: "417505" },
  { role: "sales_discounts", code: "417510" },
  { role: "vat_out", code: "240801" },
  { role: "vat_out", dimension: "tax:IVA19", code: "240801" },
  { role: "vat_out", dimension: "tax:IVA5", code: "240802" },
  // An invoice posts every tax it carries as vat_out with dimension tax:{ledger code}: INC (per rate) and the other national taxes
  // (bolsas, licores, plásticos, bebidas azucaradas, ultraprocesados, carbono) go to 249505 Impuesto nacional al consumo, never to IVA.
  // To confirm with the owner's accountant (Task 16 fix round 1; migration 0094 backfills seeded charts).
  ...["INC2", "INC4", "INC8", "INC16", "22", "32", "33", "34", "35", "23"].map((code) => ({ role: "vat_out", dimension: `tax:${code}`, code: "249505" })),
  { role: "inc_out", code: "249505" },
  { role: "vat_in", code: "240810" },
  { role: "withholding_income_suffered", code: "135515" },
  { role: "withholding_vat_suffered", code: "135517" },
  { role: "withholding_ica_suffered", code: "135518" },
  { role: "withholding_income_payable", code: "236540" },
  { role: "withholding_vat_payable", code: "236701" },
  { role: "withholding_ica_payable", code: "236801" },
  { role: "inventory", code: "143505" },
  { role: "inventory_adjustment", code: "519595" },
  { role: "cogs", code: "613595" },
  { role: "payable", code: "220505" },
  { role: "supplier_advances", code: "133005" },
  { role: "rounding", code: "530595" },
  // The exchange difference (plan 2B.2 Task 34.5, FX §5): realized on a collection, unrealized at a revaluation (dimension fx_kind:realized |
  // fx_kind:unrealized narrows them into subaccounts if the accountant wants them, e.g. for formato 2516). Provisional, owner item 126 (a):
  // the accountant confirms the codes (the seed names 530520 too).
  { role: "fx_gain", code: "421020" },
  { role: "fx_loss", code: "530525" },
  { role: "suspense", code: "238095" },
  { role: "income_summary", code: "590505" },
  { role: "current_year_profit", code: "360505" },
  { role: "current_year_loss", code: "361005" },
  { role: "retained_earnings", code: "370505" },
  { role: "accumulated_losses", code: "371005" },
  { role: "opening_equity", code: "370505" },
];
