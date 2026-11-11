import { describe, expect, it } from "vitest";
import { agingDrillHref, drillHref } from "./drill";

const dates = { p9: { from: "2026-09-01", to: "2026-09-30" }, p10: { from: "2026-10-01", to: "2026-10-31" } };
const decode = (href: string) => JSON.parse(new URLSearchParams(href.split("?")[1]).get("p")!);

describe("drillHref", () => {
  it("the account of a trial balance row opens the Auxiliar for the range of the two periods", () => {
    const href = drillHref("accounting.trial_balance", { entity: "accounting.account", id: "acc-1" }, { from: "p9", to: "p10" }, dates)!;
    expect(href.startsWith("/accounting/reports/account_detail?p=")).toBe(true);
    expect(decode(href)).toEqual({ accountId: "acc-1", from: "2026-09-01", to: "2026-10-31" });
  });

  it("the libro mayor and the balance sheet use their single period", () => {
    expect(decode(drillHref("accounting.ledger", { entity: "accounting.account", id: "a" }, { period: "p10" }, dates)!)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(decode(drillHref("accounting.balance_sheet", { entity: "accounting.account", id: "a" }, { asOfPeriod: "p9" }, dates)!)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("opens the record when the report is not a statement, the link is not an account or the period is unknown", () => {
    expect(drillHref("accounting.account_detail", { entity: "accounting.entry", id: "e" }, {}, dates)).toBeNull();
    expect(drillHref("accounting.trial_balance", { entity: "accounting.cost_center", id: "c" }, { from: "p9", to: "p10" }, dates)).toBeNull();
    expect(drillHref("accounting.trial_balance", { entity: "accounting.account", id: "a" }, { from: "nope", to: "p10" }, dates)).toBeNull();
  });
});

import { drillRange, linkTitle, rangeLabel } from "./drill";

describe("linkTitle", () => {
  const report = { columns: [{ field: "section" }, { field: "account_code" }, { field: "account_name" }], links: { account_code: { entity: "accounting.account", idField: "account_id" } } };
  const row = { section: "assets_current", account_code: "1110", account_name: "Bancos", account_id: "a1" };
  const link = { entity: "accounting.account", id: "a1" };

  it("names the tab by the clicked account, never by the row's raw section code", () => {
    expect(linkTitle(row, link, report, "assets_current")).toBe("1110 · Bancos");
  });
  it("adds the month so the same account over two ranges reads differently", () => {
    expect(linkTitle(row, link, report, "x", "octubre de 2026")).toBe("1110 · Bancos · octubre de 2026");
  });
  it("falls back when the row has no readable value", () => {
    expect(linkTitle({ account_id: "a1" }, link, report, "Registro")).toBe("Registro");
  });
  it("reads the range of a drill-down href and labels it", () => {
    const href = "/x?p=" + encodeURIComponent(JSON.stringify({ from: "2026-01-01", to: "2026-11-30" }));
    expect(drillRange(href)).toEqual({ from: "2026-01-01", to: "2026-11-30" });
    const month = (ym: string) => `mes ${ym}`;
    expect(rangeLabel({ from: "2026-01-01", to: "2026-11-30" }, month)).toBe("2026/01/01 – 2026/11/30");
    expect(rangeLabel({ from: "2026-11-01", to: "2026-11-30" }, month)).toBe("mes 2026-11");
  });
});


describe("agingDrillHref", () => {
  it("a party's bucket opens the Detalle de cartera with the aging's parameters, the party and the bucket", () => {
    const href = agingDrillHref("accounting.aging", { party_id: "p-1", currency: "COP" }, "b2", { kind: "payable", asOf: "2026-11-11", currency: "company" })!;
    expect(href.startsWith("/accounting/reports/aging_detail?p=")).toBe(true);
    expect(decode(href)).toEqual({ kind: "payable", asOf: "2026-11-11", currency: "company", partyId: "p-1", bucket: "b2" });
  });
  it("«Total» is every bucket; a currency subtotal has no party and keeps its currency in «Moneda del documento»", () => {
    expect(decode(agingDrillHref("accounting.aging", { party_id: null, currency: "USD" }, "total", { kind: "receivable", asOf: "2026-11-11", currency: "document" })!)).toEqual({
      kind: "receivable", asOf: "2026-11-11", currency: "document", currencyCode: "USD", bucket: "all",
    });
  });
  it("carries «Por vencer», so the detail of «Total» lists what the total adds", () => {
    expect(decode(agingDrillHref("accounting.aging", { party_id: "p-1" }, "total", { kind: "receivable", asOf: "2026-11-11", notDue: "include" })!)).toEqual({
      kind: "receivable", asOf: "2026-11-11", notDue: "include", partyId: "p-1", bucket: "all",
    });
  });
  it("is null for another report or a column that is no figure", () => {
    expect(agingDrillHref("accounting.trial_balance", { party_id: "p" }, "b1", {})).toBeNull();
    expect(agingDrillHref("accounting.aging", { party_id: "p" }, "party_name", {})).toBeNull();
  });
});
