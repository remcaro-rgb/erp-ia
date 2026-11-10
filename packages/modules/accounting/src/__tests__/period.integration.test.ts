import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel/testing";
import { accountingHarness, newId, type AccountingHarness, markInvoiceReady } from "./helpers";

let h: AccountingHarness;
let year: number;
let ccId: string;
let partyId: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  ccId = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  partyId = (await h.sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
    values (${h.companyId}, '{customer}', '2', '13', '900111222', 'Cliente de prueba S.A.S.', 'errors') returning id`)[0]!.id;
  await markInvoiceReady(h, partyId, "2");
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const dateIn = (month: number, day = 15) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const periodId = async (n: number) => (await h.sql<{ id: string }[]>`select id from accounting.periods where company_id = ${h.companyId} and number = ${n}`)[0]!.id;
const period = async (n: number) => (await h.sql`select * from accounting.periods where id = ${await periodId(n)}`)[0]!;
type Close = { closed: boolean; checks: { check: string; passed: boolean; value: Record<string, unknown>; note: string }[]; failed: string[] };
const close = (n: number) => periodId(n).then((id) => h.runStepUp<Close>(h.admin, "accounting.period.close", { periodId: id }));
const accountId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;

/** A posted two-line entry (the second line balances the first). */
async function post(date: string, lines: { code: string; debit?: number; credit?: number; party?: boolean; cc?: boolean }[], status: "post" | "draft" = "post") {
  const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
    date, description: "Prueba de cierre",
    lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, ...(l.party ? { partyId } : {}), ...(l.cc ? { costCenterId: ccId } : {}) })),
  });
  if (status === "post") await h.run(h.contador, "accounting.entry.save", { id });
  return id;
}
const funding = (date: string, amount = 1000) => post(date, [{ code: "111005", debit: amount }, { code: "310505", credit: amount }]);
const failedChecks = (r: Close) => r.checks.filter((c) => !c.passed).map((c) => c.check);

describe("period close", () => {
  it("close succeeds in order (N−1 first), records eleven passed checks (the diferencia en cambio warning of Task 34.7 included) with user and time, clears reopened_for; closing N+1 before N is refused", async () => {
    await funding(dateIn(1, 10));
    await expect(close(2)).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("anterior")] });
    expect(await h.sql`select 1 from accounting.period_close_checks where company_id = ${h.companyId}`).toHaveLength(0);

    await expect(h.run(h.admin, "accounting.period.close", { periodId: await periodId(1) })).rejects.toMatchObject({ code: "step_up_required" });
    const done = await close(1);
    expect(done).toMatchObject({ closed: true, failed: [] });
    expect(done.checks.map((c) => c.check)).toEqual([
      "drafts", "pending_approvals", "pending_failures", "undispatched_events", "control_receivable", "control_payable", "control_inventory",
      "suspense_zero", "rounding_within_tolerance", "contra_nature_balances", "fx_revaluation",
    ]);
    expect(done.checks.every((c) => c.passed && c.note.length > 0)).toBe(true);
    expect(await period(1)).toMatchObject({ status: "closed", closed_by: h.seed.users.both, reopened_for: null });
    expect((await period(1)).closed_at).toBeTruthy();
    const rows = await h.sql`select "check", passed, created_by, created_at from accounting.period_close_checks where period_id = ${await periodId(1)}`;
    expect(rows).toHaveLength(11);
    expect(rows.every((r) => r.passed && r.created_by === h.seed.users.both && r.created_at)).toBe(true);
    expect(await h.sql`select 1 from kernel.outbox where company_id = ${h.companyId} and event = 'accounting.period.closed'`).toHaveLength(1);
    await expect(close(1)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(close(3)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("close refuses and records checks: a draft, a pending approval, a pending failure, suspense ≠ 0 and a receivable difference above tolerance each fail their check with figures; closed is false, the period stays open and the rows exist after the refusal", async () => {
    // A draft and a pending approval dated in February.
    const draft = await post(dateIn(2, 3), [{ code: "111005", debit: 5 }, { code: "310505", credit: 5 }], "draft");
    const pending = await post(dateIn(2, 4), [{ code: "111005", debit: 6 }, { code: "310505", credit: 6 }], "draft");
    await h.sql`update accounting.entries set status = 'pending' where id = ${pending}`;
    // A pending posting failure.
    const [rule] = await h.sql<{ id: string }[]>`select id from accounting.posting_rules where company_id = ${h.companyId} limit 1`;
    await h.sql`insert into accounting.posting_failures (company_id, event_id, event, event_date, posting_rule_id, error_code, error_detail) values (${h.companyId}, ${newId()}, 'invoicing.invoice.issued', ${dateIn(2, 5)}, ${rule!.id}, 'missing_account_mapping', 'x')`;
    // Suspense with a balance; a receipt in advance (credit on receivables with no invoice) the open items do not see.
    const suspense = await post(dateIn(2, 6), [{ code: "238095", debit: 50, party: true }, { code: "111005", credit: 50 }]);
    const advance = await post(dateIn(2, 7), [{ code: "111005", debit: 100 }, { code: "130505", credit: 100, party: true }]);

    const refused = await close(2);
    expect(refused.closed).toBe(false);
    expect(failedChecks(refused)).toEqual(expect.arrayContaining(["drafts", "pending_approvals", "pending_failures", "suspense_zero", "control_receivable"]));
    const byName = Object.fromEntries(refused.checks.map((c) => [c.check, c]));
    expect(byName.drafts).toMatchObject({ value: { count: 1 }, note: expect.stringContaining("1 borrador") });
    expect(byName.pending_approvals!.value).toEqual({ count: 1 });
    expect(byName.pending_failures!.value).toEqual({ count: 1 });
    expect(byName.suspense_zero!.value).toMatchObject({ balance: 50 });
    expect(byName.suspense_zero!.note).toContain("$ 50,00");
    expect(byName.control_receivable!.value).toMatchObject({ ledger: -100, open: 0, count: 1 });
    expect(byName.control_receivable!.note).toContain("-$ 100,00");
    // The suspense account sits in the payables group: its unapplied debit shows there too.
    expect(byName.control_payable!.passed).toBe(false);
    expect(refused.failed.length).toBe(failedChecks(refused).length);
    // The refusal commits: the period is open and every check of the attempt is on record.
    expect(await period(2)).toMatchObject({ status: "open", closed_at: null });
    const rows = await h.sql`select "check", passed, value from accounting.period_close_checks where period_id = ${await periodId(2)}`;
    expect(rows).toHaveLength(11);
    expect(rows.filter((r) => !r.passed).map((r) => r.check).sort()).toEqual(failedChecks(refused).sort());

    // Fix each cause and close.
    await h.run(h.contador, "accounting.entry.delete", { id: draft });
    await h.run(h.contador, "accounting.entry.void", { id: pending, reason: "Prueba" });
    await h.sql`update accounting.posting_failures set status = 'dismissed' where company_id = ${h.companyId}`;
    await h.run(h.admin, "accounting.entry.reverse", { id: suspense, date: dateIn(2, 20), reason: "Aclarada" });
    await h.run(h.admin, "accounting.entry.reverse", { id: advance, date: dateIn(2, 21), reason: "Anticipo aplicado" });
    const second = await close(2);
    expect(second).toMatchObject({ closed: true });
    // A second set of ten rows: the attempt that failed is kept beside the one that signed off.
    expect(await h.sql`select 1 from accounting.period_close_checks where period_id = ${await periodId(2)}`).toHaveLength(22);
    expect(await period(2)).toMatchObject({ status: "closed" });
  });

  it("a contra-nature balance and an oversized rounding line each fail their check", async () => {
    await post(dateIn(3, 2), [{ code: "310505", debit: 5000 }, { code: "111005", credit: 5000 }]); // equity debited, cash credited
    await post(dateIn(3, 3), [{ code: "530595", debit: 5, cc: true }, { code: "111005", credit: 5 }]); // 5 COP straight on the rounding account
    const refused = await close(3);
    expect(failedChecks(refused)).toEqual(expect.arrayContaining(["contra_nature_balances", "rounding_within_tolerance"]));
    expect(refused.checks.find((c) => c.check === "rounding_within_tolerance")!.note).toContain("tolerancia");
    expect((await period(3)).status).toBe("open");
  });

  it("reopened_for admits only that day: a post dated another day of the period is closed_period; the right day posts; close again clears it", async () => {
    await h.runStepUp(h.admin, "accounting.period.reopen", { periodId: await periodId(1), date: dateIn(1, 11) });
    expect(await period(1)).toMatchObject({ status: "open", reopened_count: 1 });
    expect(String((await period(1)).reopened_for).slice(0, 10)).toBeTruthy();
    const other = await post(dateIn(1, 12), [{ code: "111005", debit: 7 }, { code: "310505", credit: 7 }], "draft");
    await expect(h.run(h.contador, "accounting.entry.save", { id: other })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("closed_period") });
    const right = await post(dateIn(1, 11), [{ code: "111005", debit: 9 }, { code: "310505", credit: 9 }]);
    expect((await h.sql`select status from accounting.entries where id = ${right}`)[0]).toMatchObject({ status: "posted" });
    await h.run(h.contador, "accounting.entry.delete", { id: other });
    expect(await close(1)).toMatchObject({ closed: true });
    expect(await period(1)).toMatchObject({ status: "closed", reopened_for: null, reopened_count: 1 });
    expect(await h.sql`select 1 from accounting.period_close_checks where period_id = ${await periodId(1)}`).toHaveLength(22);
  });

  it("reopened post moves later opening balances: an entry posted into January after February closed changes February's opening in v_account_balances with no other write", async () => {
    const openingOfFebruary = () =>
      withClaims(h.sql, h.admin.claims, async (tx) =>
        Number((await tx<{ balance: string | null }[]>`
          select sum(b.debit - b.credit) as balance from accounting.v_account_balances b join accounting.periods p on p.id = b.period_id
          where b.account_id = ${await accountId("111005")} and p.ends_on < (select starts_on from accounting.periods where company_id = ${h.companyId} and number = 2)`)[0]!.balance ?? 0));
    const before = await openingOfFebruary();
    const periodsBefore = await h.sql`select id, status, reopened_count, closed_at from accounting.periods where company_id = ${h.companyId} and number > 1 order by number`;
    await h.runStepUp(h.admin, "accounting.period.reopen", { periodId: await periodId(1), date: dateIn(1, 18) });
    await post(dateIn(1, 18), [{ code: "111005", debit: 250 }, { code: "310505", credit: 250 }]);
    expect(await openingOfFebruary()).toBe(before + 250);
    // Nothing else was written: the later periods are as they were.
    expect(await h.sql`select id, status, reopened_count, closed_at from accounting.periods where company_id = ${h.companyId} and number > 1 order by number`).toEqual(periodsBefore);
    expect(await close(1)).toMatchObject({ closed: true });
  });

  it("reopen refuses an open period, a date outside the period and a closed year", async () => {
    await expect(h.runStepUp(h.admin, "accounting.period.reopen", { periodId: await periodId(5) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.runStepUp(h.admin, "accounting.period.reopen", { periodId: await periodId(1), date: dateIn(2, 2) })).rejects.toMatchObject({ code: "invalid_input" });
    await h.sql`update accounting.fiscal_years set status = 'closed' where company_id = ${h.companyId}`;
    await expect(h.runStepUp(h.admin, "accounting.period.reopen", { periodId: await periodId(1) })).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("year.reopen")] });
    await h.sql`update accounting.fiscal_years set status = 'open' where company_id = ${h.companyId}`;
    await expect(close(5)).rejects.toMatchObject({ code: "invalid_input" });
  });
});
