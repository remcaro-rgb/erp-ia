import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The default posting rules are shipped twice (FX §4, plan 2B.2 Task 34.4): by the module that emits the event (invoicing/src/rules/) and
// by accounting (rules/defaults/). The sync matches a company's copy by (event, name), so the two copies must be the same rule: a test, not
// a convention. Since Task 34.4 every invoicing rule posts both amounts (R34-4): the entry's currency and rate come from the payload, each
// line's `amount` reads the document twin (`*Doc`) and `amountCompany` the field that always held company amounts.

const dir = (path: string) => new URL(path, import.meta.url);
const INVOICING = dir("../../../invoicing/src/rules/");
const ACCOUNTING = dir("../rules/defaults/");
const json = (base: URL, name: string) => JSON.parse(readFileSync(new URL(name, base), "utf8")) as {
  template: { currency?: string; exchangeRate?: string; lines: { amount: string; amountCompany?: string }[] };
};
const invoicingRules = readdirSync(INVOICING).filter((name) => name.endsWith(".json")).sort();
const PAYMENTS = dir("../../../payments/src/rules/");
const paymentsRules = readdirSync(PAYMENTS).filter((name) => name.endsWith(".json")).sort();

describe("the default rules shipped twice", () => {
  it("invoicing ships the invoice and the three note rules", () => {
    expect(invoicingRules).toEqual(["invoice-issued.json", "note-annulment-issued.json", "note-credit-issued.json", "note-debit-issued.json"]);
  });

  it.each(invoicingRules)("%s is identical to its twin in accounting/src/rules/defaults/", (name) => {
    expect(json(INVOICING, name)).toEqual(json(ACCOUNTING, name));
  });

  it.each(invoicingRules)("%s posts the document currency and rate, the document amount and the company amount of every line (R34-4)", (name) => {
    const { template } = json(INVOICING, name);
    expect(template.currency).toBe("$.currency");
    expect(template.exchangeRate).toBe("$.exchangeRate");
    for (const line of template.lines) {
      expect(line.amount, JSON.stringify(line)).toMatch(/Doc$/);
      expect(line.amountCompany, JSON.stringify(line)).toBe(line.amount.replace(/Doc$/, ""));
    }
  });
});

describe("the payments rules shipped twice (plan 2B.2 Task 34.5)", () => {
  it.each(paymentsRules)("%s is identical to its twin in accounting/src/rules/defaults/", (name) => {
    expect(json(PAYMENTS, name)).toEqual(json(ACCOUNTING, name));
  });

  it("payment-received posts the receipt's currency and rate, both amounts of every line, and the realized difference per allocation (FX §5)", () => {
    const { template } = json(PAYMENTS, "payment-received.json") as unknown as {
      template: { currency?: string; exchangeRate?: string; lines: { role: string; side: string; amount: string; amountCompany?: string; forEach?: string; dimension?: string }[] };
    };
    expect(template.currency).toBe("$.currency");
    expect(template.exchangeRate).toBe("$.exchangeRate");
    for (const line of template.lines.filter((l) => !l.role.startsWith("fx_"))) {
      expect(line.amount, JSON.stringify(line)).toMatch(/Doc$/);
      expect(line.amountCompany, JSON.stringify(line)).toBe(line.amount.replace(/Doc$/, ""));
    }
    // An exchange difference has pesos only: its document amount is 0, so it never unbalances the receipt's currency.
    expect(template.lines.filter((l) => l.role.startsWith("fx_")).map(({ role, side, amount, amountCompany, forEach, dimension }) => ({ role, side, amount, amountCompany, forEach, dimension }))).toEqual([
      { role: "fx_loss", side: "debit", amount: "0", amountCompany: "$.fx.loss", forEach: "$.allocations[*]", dimension: "fx_kind:realized" },
      { role: "fx_gain", side: "credit", amount: "0", amountCompany: "$.fx.gain", forEach: "$.allocations[*]", dimension: "fx_kind:realized" },
    ]);
  });
});

// The sales rules (plan 2B.2 Task 30.2, Part G PG §5.4, RG-13): the provision of a commission (Dr commission_expense per line, by payee kind,
// on the line's cost center / Cr commissions_payable for the payee with the provision's due date) and its reversal (reverseOf). Shipped by
// sales (its manifest's postingRules) and kept here as their twins, byte for byte.
const SALES = dir("../../../sales/src/rules/");
const salesRules = readdirSync(SALES).filter((name) => name.endsWith(".json")).sort();

describe("the sales rules shipped twice (plan 2B.2 Task 30.2)", () => {
  it("sales ships the commission accrual and its reversal", () => {
    expect(salesRules).toEqual(["commission-accrued.json", "commission-reversed.json"]);
  });

  it.each(salesRules)("%s is identical to its twin in accounting/src/rules/defaults/", (name) => {
    expect(json(SALES, name)).toEqual(json(ACCOUNTING, name));
  });

  it("commission-accrued debits the expense per line by payee kind and credits the payable for the payee with its due date", () => {
    const rule = JSON.parse(readFileSync(new URL("commission-accrued.json", SALES), "utf8")) as {
      event: string; template: { source: { entity: string; id: string }; lines: Record<string, string>[] };
    };
    expect(rule.event).toBe("sales.commission.accrued");
    expect(rule.template.source).toEqual({ entity: "sales.commission", id: "$.commissionId" });
    expect(rule.template.lines).toEqual([
      { role: "commission_expense", side: "debit", forEach: "$.lines[*]", amount: "$.amount", costCenter: "$.costCenterId", dimension: "payee_kind:{{$$.payeeKind}}" },
      { role: "commissions_payable", side: "credit", amount: "$.total", party: "$.payeePartyId", dueDate: "$.dueDate", dimension: "payee_kind:{{payeeKind}}" },
    ]);
    const reversed = JSON.parse(readFileSync(new URL("commission-reversed.json", SALES), "utf8")) as { event: string; template: { lines: unknown[]; reverseOf: unknown } };
    expect(reversed.event).toBe("sales.commission.reversed");
    expect(reversed.template.lines).toEqual([]);
    expect(reversed.template.reverseOf).toEqual({ event: "sales.commission.accrued", sourceId: "$.commissionId" });
  });
});
