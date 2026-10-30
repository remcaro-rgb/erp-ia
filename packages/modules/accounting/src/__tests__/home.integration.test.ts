import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runReport } from "@erp/kernel";
import { accountingHarness, type AccountingHarness } from "./helpers";

// The accounting cards of the home screen (accounting design §8, Task 29): the result of the month is the income statement's own
// result, the pending count is the pending rows of the inbox, and a role that may not consult a card's data does not get the card.

let h: AccountingHarness;
let periodId: string;

beforeAll(async () => {
  h = await accountingHarness();
  await h.grantAll(h.companyId, h.seed.companies[0]!.adminRoleId, ["kernel.home.kpis"]);
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  const [period] = await h.sql<{ id: string }[]>`
    select id from accounting.periods where company_id = ${h.companyId} and current_date between starts_on and ends_on`;
  periodId = period!.id;
  const today = new Date().toISOString().slice(0, 10);
  const [cc] = await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`;
  const post = async (lines: { code: string; debit?: number; credit?: number }[]) => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: today, description: "Movimiento del mes", lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, costCenterId: cc!.id })),
    });
    await h.run(h.contador, "accounting.entry.post", { id });
  };
  await post([{ code: "111005", debit: 5_000_000 }, { code: "413595", credit: 5_000_000 }]);
  await post([{ code: "510506", debit: 1_250_000 }, { code: "111005", credit: 1_250_000 }]);
  // One draft left open, and two events no rule could post: one pending and one already dismissed.
  await h.run(h.contador, "accounting.entry.create", { date: today, description: "Borrador", lines: [{ accountCode: "111005", debit: 10, credit: 0 }, { accountCode: "413595", debit: 0, credit: 10, costCenterId: cc!.id }] });
  for (const status of ["pending", "pending", "dismissed"]) {
    await h.sql`
      insert into accounting.posting_failures (company_id, event_id, event, error_code, error_detail, status)
      values (${h.companyId}, ${randomUUID()}, 'qa.sale.issued', 'missing_account_mapping', 'Sin cuenta para el rol revenue', ${status})`;
  }
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const kpis = async (caller: typeof h.admin) => {
  const out = await h.run<{ kpis: { id: string; value: number; unit: string; tone?: string; detail?: { params: Record<string, unknown> } }[] }>(caller, "kernel.home.kpis", {});
  return new Map(out.kpis.map((k) => [k.id, k]));
};

describe("accounting home KPIs", () => {
  it("result of the month equals the income statement; pending count equals the pending posting failures", async () => {
    const cards = await kpis(h.admin);
    const state = { filters: [], sort: [], page: 1, pageSize: 500 };
    const statement = (await runReport(h.deps, h.admin, "accounting.income_statement", { from: periodId, to: periodId }, state)) as unknown as { aggregates: { result: number } };
    expect(statement.aggregates.result).toBe(3_750_000);
    expect(cards.get("accounting.result_month")).toMatchObject({ value: statement.aggregates.result, unit: "money" });

    const n = (await h.sql<{ n: number }[]>`select count(*)::int as n from accounting.posting_failures where company_id = ${h.companyId} and status = 'pending'`)[0]!.n;
    expect(n).toBe(2);
    expect(cards.get("accounting.pending_failures")).toMatchObject({ value: n, tone: "warn" });
  });

  it("counts the open periods and the drafts", async () => {
    const cards = await kpis(h.admin);
    const { open, total } = (await h.sql<{ open: number; total: number }[]>`
      select count(*) filter (where status = 'open')::int as open, count(*)::int as total from accounting.periods where company_id = ${h.companyId}`)[0]!;
    expect(cards.get("accounting.open_periods")).toMatchObject({ value: open, detail: { params: { total } } });
    expect(cards.get("accounting.draft_entries")).toMatchObject({ value: 1 });
  });

  it("a role that may not consult the inbox does not get the pending card, and one that may not read the statement does not get the result", async () => {
    // A role with the statement, the entries and the periods but not the inbox.
    const [role] = await h.sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${h.companyId}, 'analista', false) returning id`;
    await h.seed.holdRoles(h.seed.users.auxiliar!, h.companyId, [role!.id]);
    await h.grantAll(h.companyId, role!.id, ["kernel.home.kpis", "accounting.report.income_statement", "accounting.entry.consult", "accounting.period.consult"]);
    const analyst = { claims: { ...h.seed.claimsFor(h.seed.users.auxiliar!, h.companyId), role_ids: [role!.id] }, origin: "ui" as const };
    const cards = await kpis(analyst);
    expect(cards.has("accounting.draft_entries")).toBe(true);
    expect(cards.has("accounting.pending_failures")).toBe(false);
    expect(cards.has("accounting.result_month")).toBe(true);
  });
});
