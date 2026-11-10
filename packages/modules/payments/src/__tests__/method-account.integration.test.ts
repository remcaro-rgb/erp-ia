import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { payments } from "../index";
import paymentReceivedRule from "../rules/payment-received.json" with { type: "json" };
import { paymentsHarness, type Harness } from "./helpers";

// The bank account of one medio de pago (plan 2B.2 Task 34.8b; owner item 135; FX §6 «a USD receipt lands in the USD bank account the
// method maps to»): the receipt's cash line names an ordered list of dimensions, `payment_method_id:<the method's id>` then
// `payment_method:<its kind>`; the first one mapped for the role cash wins, then the role alone (kernel engine, accounting provider).
//   (1) a USD method mapped to its own account (the method's «Contabilidad» tab) debits that account; another transfer method without a
//       mapping of its own keeps the kind's account;
//   (2) Anular reverses the method's account;
//   (3) the payment method record contributes the mapping tab, keyed by the method's id, role cash;
//   (4) 0154 rewrites the unedited copies of «Recibo de caja» (the 0151 shape) to the shipped rule, leaves an edited one, and runs twice.

const migration = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const BANK = "111005";
/** PUC 111010 Bancos · Moneda extranjera (in the seeded chart). */
const USD_BANK = "111010";

let h: Harness;
let usdMethod: string;
let otherTransfer: string;
let exportGood: string;
beforeAll(async () => {
  h = await paymentsHarness();
  usdMethod = (await h.run<{ id: string }>(h.admin, "payments.method.create", { code: "TRF-USD", name: "Transferencia USD", kind: "transfer", meansCode: "47", currency: "USD" })).id;
  otherTransfer = (await h.run<{ id: string }>(h.admin, "payments.method.create", { code: "TRF-2", name: "Transferencia Banco 2", kind: "transfer", meansCode: "47" })).id;
  exportGood = (await h.run<{ id: string }>(h.admin, "core.product.create", {
    sku: "EXP-02", description: "Café verde de exportación", kind: "service", idScheme: "999", uomCode: "94", ivaRate: "0", otherTaxes: [], listPrice: 100000, isFreeSample: false, trackStock: false,
  })).id;
  const [account] = await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${USD_BANK}`;
  await h.runStepUp("accounting.account_role_mapping.update", { mappings: [{ role: "cash", dimension: `payment_method_id:${usdMethod}`, accountId: account!.id }] });
}, 300_000);
afterAll(async () => {
  await h.cleanup();
});

const debitCodes = async (receiptId: string, reversal = false) => {
  const entry = (await h.entriesOfSource(receiptId)).find((e) => (e.reversal_of_id !== null) === reversal)!;
  return (await h.linesOf(entry.id)).map((l) => [l.code, Number(l.debit), Number(l.credit)]);
};

describe("(1) the bank account of the medio de pago", () => {
  it("a USD receipt through the mapped method debits the method's own account", async () => {
    const invoice = await h.issuedInvoice(1, { currency: "USD", exchangeRate: 4000, productId: exportGood, unitPrice: 100 });
    const receipt = await h.receive({ amount: 100, methodId: usdMethod, currency: "USD", exchangeRate: 4000, allocations: [{ invoiceId: invoice.id, amount: 100 }] });
    expect((await debitCodes(receipt.id))[0]).toEqual([USD_BANK, 400000, 0]);
    // (2) Anular reverses it on the same account.
    await h.runStepUp("payments.payment.void", { id: receipt.id, reason: "prueba" });
    expect(await debitCodes(receipt.id, true)).toContainEqual([USD_BANK, 0, 400000]);
  });

  it("a transfer method without a mapping of its own keeps the account of its kind", async () => {
    const invoice = await h.issuedInvoice(1);
    const receipt = await h.receive({ amount: invoice.total, methodId: otherTransfer, allocations: [{ invoiceId: invoice.id, amount: invoice.total }] });
    expect((await debitCodes(receipt.id))[0]![0]).toBe(BANK);
  });
});

describe("(3) the mapping tab of a medio de pago", () => {
  it("the method record contributes «Contabilidad»: role cash, keyed by the method's id", () => {
    const tab = payments.recordTabs?.find((t) => t.id === "payments.method_account");
    expect(tab).toMatchObject({ kind: "mapping", forEntities: ["payments.method"], dimension: "payment_method_id:{id}", roles: ["cash"], lookupEntity: "accounting.account", saveProcess: "accounting.account_role_mapping.update", consultProcess: "accounting.account_role_mapping.consult" });
  });
  it("the shipped receipt rule tries the method, then its kind", () => {
    const cash = paymentReceivedRule.template.lines.find((l) => l.role === "cash")!;
    expect(cash.dimension).toEqual(["payment_method_id:{{methodId}}", "payment_method:{{method}}"]);
  });
});

describe("(4) migration 0154 on the copies of «Recibo de caja»", () => {
  const setRule = (template: unknown, modified: boolean) => h.sql`
    update accounting.posting_rules set template = ${h.sql.json(template as never)}, is_modified = ${modified} where company_id = ${h.companyId} and event = 'payments.received' and name = 'Recibo de caja'`;
  const ruleTemplate = async () => (await h.sql<{ template: unknown }[]>`
    select template from accounting.posting_rules where company_id = ${h.companyId} and event = 'payments.received' and name = 'Recibo de caja'`)[0]!.template;
  /** The rule as 0151 left it: the cash line by kind only. */
  const before0154 = () => {
    const template = structuredClone(paymentReceivedRule.template) as unknown as { lines: { role: string; dimension?: unknown }[] };
    template.lines = template.lines.map((l) => (l.role === "cash" ? { ...l, dimension: "payment_method:{{method}}" } : l));
    return template;
  };

  it("rewrites an unedited copy to the shipped rule, leaves an edited one, and runs twice", async () => {
    await setRule(before0154(), false);
    for (let run = 0; run < 2; run++) await h.sql.begin((tx) => tx.unsafe(migration("0154_payments_rules_method_account.sql")));
    expect(await ruleTemplate()).toEqual(paymentReceivedRule.template);
    await setRule(before0154(), true);
    await h.sql.begin((tx) => tx.unsafe(migration("0154_payments_rules_method_account.sql")));
    expect(await ruleTemplate()).toEqual(before0154());
    await setRule(paymentReceivedRule.template, false);
  });
});
