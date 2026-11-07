import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
beforeAll(async () => {
  h = await accountingHarness();
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const settings = async () => (await h.sql`select * from accounting.settings where company_id = ${h.companyId}`)[0];

describe("settings", () => {
  it("before the chart is seeded, consult says so and update asks to configure the accounting first", async () => {
    expect(await h.run(h.admin, "accounting.settings.consult", {})).toMatchObject({ configured: false, useItems: false, roundingTolerance: 1 });
    await expect(h.runStepUp(h.admin, "accounting.settings.update", { useItems: true })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("settings.update toggles use_items under step-up and refuses a negative tolerance", async () => {
    await h.runStepUp(h.admin, "accounting.chart.seed", {});
    await expect(h.run(h.admin, "accounting.settings.update", { useItems: true })).rejects.toMatchObject({ code: "step_up_required" });
    await h.runStepUp(h.admin, "accounting.settings.update", { useItems: true, requireApprovalOnManual: true, roundingTolerance: 2.5, niifGroup: "1" });
    expect(await settings()).toMatchObject({ use_items: true, require_approval_on_manual: true, rounding_tolerance: "2.5000", niif_group: "1", use_business_units: false });
    await expect(h.runStepUp(h.admin, "accounting.settings.update", { roundingTolerance: -1 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.runStepUp(h.admin, "accounting.settings.update", { niifGroup: "4" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await settings()).toMatchObject({ rounding_tolerance: "2.5000" });
  });

  it("the manual fuente must be an active fuente that takes manual entries", async () => {
    const [ap] = await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'AP'`;
    await expect(h.runStepUp(h.admin, "accounting.settings.update", { manualJournalId: ap!.id })).rejects.toMatchObject({ code: "invalid_input" });
    const [cp] = await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'CP'`;
    await h.runStepUp(h.admin, "accounting.settings.update", { manualJournalId: cp!.id });
    expect((await settings())!.manual_journal_id).toBe(cp!.id);
  });

  it("consult counts the events acknowledged without posting because they predate the start of the ledger", async () => {
    expect(await h.run(h.admin, "accounting.settings.consult", {})).toMatchObject({ skippedEvents: 0 });
    await h.sql`insert into accounting.skipped_events (company_id, outbox_id, event, event_date) values (${h.companyId}, ${randomUUID()}, 'qa.sale.issued', '2020-01-15')`;
    expect(await h.run(h.admin, "accounting.settings.consult", {})).toMatchObject({ skippedEvents: 1 });
  });

  it("consult returns the configuration to a member who may consult; update is refused to a member", async () => {
    expect(await h.run(h.contador, "accounting.settings.consult", {})).toMatchObject({ configured: true, useItems: true, requireApprovalOnManual: true, roundingTolerance: 2.5, niifGroup: "1" });
    await expect(h.runStepUp(h.contador, "accounting.settings.update", { useItems: false })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rule_stale_days defaults to 30, is consulted and updated, and must be a positive whole number of days", async () => {
    expect(await h.run(h.admin, "accounting.settings.consult", {})).toMatchObject({ ruleStaleDays: 30 });
    await h.runStepUp(h.admin, "accounting.settings.update", { ruleStaleDays: 45 });
    expect(await settings()).toMatchObject({ rule_stale_days: 45 });
    expect(await h.run(h.admin, "accounting.settings.consult", {})).toMatchObject({ ruleStaleDays: 45 });
    for (const bad of [0, -3, 1.5, 4000]) await expect(h.runStepUp(h.admin, "accounting.settings.update", { ruleStaleDays: bad })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.sql`update accounting.settings set rule_stale_days = 0 where company_id = ${h.companyId}`).rejects.toThrow();
    await h.runStepUp(h.admin, "accounting.settings.update", { ruleStaleDays: 30 });
  });
});
