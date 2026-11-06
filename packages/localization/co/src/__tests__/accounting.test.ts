import { describe, expect, it } from "vitest";
import { ACCOUNT_ROLES } from "@erp/kernel";
import { co } from "../index";

const acc = co.accounting;

describe("Colombia accounting pack", () => {
  it("the chart has every class, group and account of the PUC and flags parties and cost centers per §10.3", () => {
    const c = acc.chartOfAccounts();
    for (const klass of "123456789") expect(c.some((a) => a.code === klass)).toBe(true);
    for (const group of ["11", "13", "22", "24", "36", "41", "51", "61", "71"]) expect(c.some((a) => a.code === group)).toBe(true);
    expect(c.find((a) => a.code === "130505")).toMatchObject({ nature: "debit", requiresParty: true, requiresCostCenter: false });
    expect(c.find((a) => a.code === "510506")).toMatchObject({ requiresCostCenter: true });
    expect(c.find((a) => a.code === "3605")?.isOpeningResult).toBe(true);
    expect(c.find((a) => a.code === "3705")?.isOpeningResult).toBe(true);
    expect(c.find((a) => a.code === "3710")?.isOpeningResult).toBe(true);
    expect(c.find((a) => a.code === "110505")).toMatchObject({ requiresParty: false, requiresCostCenter: false });
    expect(c.find((a) => a.code === "220505")).toMatchObject({ nature: "credit", requiresParty: true });
    expect(c.find((a) => a.code === "1592")?.nature).toBe("credit");
    expect(c.find((a) => a.code === "4175")?.nature).toBe("debit");
    expect(new Set(c.map((a) => a.code)).size).toBe(c.length);
    for (const a of c) expect(acc.validateAccountCode(a.code, parentOf(a.code))).toMatchObject({ ok: true });
  });

  it("has the movement subcuentas a company that buys and sells goods needs: taxes, payroll, purchases and returns (demo seed, 2026-11-02)", () => {
    const codes = new Set(acc.chartOfAccounts().map((a) => a.code));
    const basic = [
      "110505", "110510", "111005", "130505", "133005", "135515", "135517", "135518", "143505", "152405", "159205",
      "220505", "233540", "233550", "236540", "236525", "236701", "236801", "240405", "240801", "240802", "240810", "241205",
      "250505", "251010", "251505", "252005", "252505", "261005", "261010", "261015", "261020",
      "310505", "330505", "360505", "370505", "413505", "413595", "417505", "421005",
      "510506", "510530", "510536", "510539", "512010", "513530", "514520", "530505", "530520", "613505", "613595", "620505", "622505",
    ];
    for (const code of basic) expect(codes.has(code), code).toBe(true);
    const c = acc.chartOfAccounts();
    expect(c.find((a) => a.code === "622505")?.nature).toBe("credit");
    expect(c.find((a) => a.code === "620505")).toMatchObject({ nature: "debit", statementSection: "cost_of_sales" });
    expect(c.find((a) => a.code === "250505")).toMatchObject({ nature: "credit", requiresParty: true, requiresInvoiceReady: false });
  });

  it("every account role of the kernel catalogue has a default mapping and every mapped code exists in the chart or in extraAccounts", () => {
    const mappings = acc.defaultRoleMappings();
    const known = new Set([...acc.chartOfAccounts(), ...acc.extraAccounts()].map((a) => a.code));
    for (const role of ACCOUNT_ROLES) expect(mappings.some((m) => m.role === role && !m.dimension), role).toBe(true);
    for (const m of mappings) expect(known.has(m.code), `${m.role} → ${m.code}`).toBe(true);
    expect(mappings.find((m) => m.role === "vat_out" && m.dimension === "tax:IVA19")?.code).toBe("240801");
    expect(mappings.find((m) => m.role === "vat_out" && m.dimension === "tax:IVA5")?.code).toBe("240802");
    // INC and the other national taxes an invoice carries post to 249505 (Impuesto nacional al consumo), never to the IVA account (fix round 1
    // of Task 16; the account is to confirm with the owner's accountant).
    for (const code of ["INC2", "INC4", "INC8", "INC16", "22", "32", "33", "34", "35", "23"]) {
      expect(mappings.find((m) => m.role === "vat_out" && m.dimension === `tax:${code}`)?.code, code).toBe("249505");
    }
    // A receipt's cash line resolves by its medio de pago (payment_method:<code>, plan 2B Task 21): cash and cheques to the caja, transfers
    // and cards to the bank (to confirm with the owner's accountant; migration 0110 backfills seeded charts).
    expect(Object.fromEntries(mappings.filter((m) => m.role === "cash" && m.dimension).map((m) => [m.dimension, m.code]))).toEqual({
      "payment_method:cash": "110505", "payment_method:transfer": "111005", "payment_method:card": "111005", "payment_method:check": "110505",
    });
    expect(mappings.find((m) => m.role === "suspense")?.code).toBe("238095");
    expect(mappings.find((m) => m.role === "rounding")?.code).toBe("530595");
    expect(acc.extraAccounts().map((a) => a.code).sort()).toEqual(["238095", "530595"]);
    const chart = new Set(acc.chartOfAccounts().map((a) => a.code));
    expect(chart.has("2380") && chart.has("5305")).toBe(true);
    expect(chart.has("238095") || chart.has("530595")).toBe(false);
  });

  it("validateAccountCode accepts 13050501 under 130505 and refuses 1306 under 1305, letters, and a child not prefixed by its parent", () => {
    expect(acc.validateAccountCode("13050501", "130505")).toEqual({ ok: true, level: "auxiliary" });
    expect(acc.validateAccountCode("130505", "1305")).toEqual({ ok: true, level: "subaccount" });
    expect(acc.validateAccountCode("1305", "13")).toEqual({ ok: true, level: "account" });
    expect(acc.validateAccountCode("13")).toEqual({ ok: true, level: "group" });
    expect(acc.validateAccountCode("1")).toEqual({ ok: true, level: "class" });
    expect(acc.validateAccountCode("1306", "1305")).toMatchObject({ ok: false });
    expect(acc.validateAccountCode("13A505")).toMatchObject({ ok: false });
    expect(acc.validateAccountCode("1305", "1405")).toMatchObject({ ok: false });
    expect(acc.validateAccountCode("130", "13")).toMatchObject({ ok: false });
    expect(acc.validateAccountCode("1305", "1305")).toMatchObject({ ok: false });
  });

  it("fiscalYearFor is the calendar year and the journals are the seven of §4.3", () => {
    expect(acc.fiscalYearFor("2026-10-30")).toEqual({ year: 2026, startsOn: "2026-01-01", endsOn: "2026-12-31" });
    expect(() => acc.fiscalYearFor("30/10/2026")).toThrow();
    const journals = acc.defaultJournals();
    expect(journals.map((j) => j.code)).toEqual(["NC", "VT", "CP", "RC", "CE", "AP", "CI"]);
    expect(journals.map((j) => j.kind)).toEqual(["general", "sales", "purchases", "receipts", "payments", "opening", "closing"]);
    expect(journals.filter((j) => !j.manualEntries).map((j) => j.code)).toEqual(["AP", "CI"]);
    expect(journals.find((j) => j.code === "VT")?.name).toBe("Ventas");
  });

  it("lays out the statements and the 2516 lines by account prefix, and lists the tax codes", () => {
    const l = acc.statementLayouts();
    expect(l.balanceSheet.map((s) => s.code)).toEqual(["assets_current", "assets_noncurrent", "liabilities_current", "liabilities_noncurrent", "equity"]);
    const sections = new Set(acc.chartOfAccounts().map((a) => a.statementSection).filter(Boolean));
    for (const s of [...l.balanceSheet, ...l.incomeStatement]) expect(sections.has(s.code), s.code).toBe(true);
    expect(l.f2516.esf.find((x) => x.prefixes.includes("11"))).toBeDefined();
    expect(l.f2516.eri.find((x) => x.prefixes.includes("41"))).toBeDefined();
    const codes = acc.taxCodes().map((t) => t.code);
    expect(codes).toEqual(expect.arrayContaining(["IVA19", "IVA5", "IVA0", "EXC", "INC8", "RTEFTE", "RTEIVA", "RTEICA"]));
    expect(acc.taxCodes().find((t) => t.code === "IVA19")).toMatchObject({ family: "IVA", rate: 19 });
  });
});

const parentOf = (code: string): string | undefined => (code.length === 1 ? undefined : code.length === 2 ? code.slice(0, 1) : code.length === 4 ? code.slice(0, 2) : code.slice(0, 4));
