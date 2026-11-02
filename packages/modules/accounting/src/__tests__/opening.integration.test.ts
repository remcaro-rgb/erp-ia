import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, type AccountingHarness, markInvoiceReady } from "./helpers";

let h: AccountingHarness;
let ccId: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  ccId = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  const [party] = await h.sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
    values (${h.companyId}, '{customer}', '2', '13', '900111222', 'Cliente de prueba S.A.S.', 'errors') returning id`;
  await markInvoiceReady(h, party!.id, "2");
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const lines = (extra: object[] = []) => [
  { accountCode: "111005", debit: 1_000_000, credit: 0 },
  { accountCode: "130505", partyDocument: "900111222", debit: 500_000, credit: 0 },
  { accountCode: "310505", debit: 0, credit: 1_500_000 },
  ...extra,
];

describe("opening balances", () => {
  it("opening.create resolves codes and documents into a draft in AP with is_opening dated ledger_starts_on; opening.post needs step-up", async () => {
    const [settings] = await h.sql<{ ledger_starts_on: string }[]>`select ledger_starts_on::text from accounting.settings where company_id = ${h.companyId}`;
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.opening.create", { lines: lines() });
    const [entry] = await h.sql`select e.status, e.origin, e.is_opening, e.date::text as date, e.number, j.code as journal from accounting.entries e join accounting.journals j on j.id = e.journal_id where e.id = ${id}`;
    expect(entry).toMatchObject({ status: "draft", origin: "import", is_opening: true, date: settings!.ledger_starts_on, number: null, journal: "AP" });
    const rows = await h.sql`select a.code, l.party_id is not null as has_party, l.debit, l.credit from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${id} order by l.line_no`;
    expect(rows.map((r) => [r.code, r.has_party, r.debit, r.credit])).toEqual([
      ["111005", false, "1000000.0000", "0.0000"], ["130505", true, "500000.0000", "0.0000"], ["310505", false, "0.0000", "1500000.0000"],
    ]);

    // Posting is the human step: it needs a fresh verification, and then it posts in AP-1.
    await expect(h.run(h.admin, "accounting.opening.post", { id })).rejects.toMatchObject({ code: "step_up_required" });
    const out = await h.runStepUp<{ number: string }>(h.admin, "accounting.opening.post", { id });
    expect(out.number).toBe("AP-1");
    expect((await h.sql`select status, is_opening from accounting.entries where id = ${id}`)[0]).toMatchObject({ status: "posted", is_opening: true });
    // A second post is refused, and opening.post only takes opening entries.
    await expect(h.runStepUp(h.admin, "accounting.opening.post", { id })).rejects.toMatchObject({ code: "invalid_input" });
    const plain = await h.run<{ id: string }>(h.contador, "accounting.entry.create", { date: "2026-03-01", description: "x", lines: [] });
    await expect(h.runStepUp(h.admin, "accounting.opening.post", { id: plain.id })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses an unknown account, an unknown party document or dimension code, and a line with both sides; an unbalanced opening cannot post", async () => {
    await expect(h.run(h.contador, "accounting.opening.create", { lines: lines([{ accountCode: "999999", debit: 1, credit: 0 }]) })).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("999999")] });
    await expect(h.run(h.contador, "accounting.opening.create", { lines: [{ accountCode: "130505", partyDocument: "123", debit: 1, credit: 0 }] })).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("123")] });
    await expect(h.run(h.contador, "accounting.opening.create", { lines: [{ accountCode: "510506", costCenterCode: "NOPE", debit: 1, credit: 0 }] })).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("NOPE")] });
    await expect(h.run(h.contador, "accounting.opening.create", { lines: [{ accountCode: "111005", debit: 1, credit: 1 }] })).rejects.toMatchObject({ code: "invalid_input" });
    const ok = await h.run<{ id: string }>(h.contador, "accounting.opening.create", { lines: [{ accountCode: "510506", costCenterCode: "ADM", debit: 50, credit: 0 }, { accountCode: "111005", debit: 0, credit: 40 }] });
    expect((await h.sql`select cost_center_id from accounting.entry_lines where entry_id = ${ok.id} and line_no = 1`)[0]!.cost_center_id).toBe(ccId);
    await expect(h.runStepUp(h.admin, "accounting.opening.post", { id: ok.id })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("unbalanced") });
  });

  it("an opening entry dated in a closed period is a closed_period refusal", async () => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.opening.create", { lines: [{ accountCode: "111005", debit: 5, credit: 0 }, { accountCode: "310505", debit: 0, credit: 5 }] });
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and ${(await h.sql<{ d: string }[]>`select date::text as d from accounting.entries where id = ${id}`)[0]!.d}::date between starts_on and ends_on`;
    await expect(h.runStepUp(h.admin, "accounting.opening.post", { id })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("closed_period") });
  });
});
