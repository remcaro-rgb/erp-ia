import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, type AccountingHarness } from "./helpers";

// Task 50.6 (owner item 6): a rule with a `when` that matched no event in N days is flagged `stale` by posting_rule.consult.

let h: AccountingHarness;
let journalId: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  journalId = (await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`)[0]!.id;
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const EVENT = "qa.stale.thing";
const template = (when?: unknown) => ({
  ...(when ? { when } : {}),
  date: "$.date",
  description: "Prueba de regla sin coincidencias",
  source: { entity: "qa.thing", id: "$.id" },
  lines: [
    { role: "inventory", side: "debit", amount: "$.total" },
    { role: "inventory_adjustment", side: "credit", amount: "$.total" },
  ],
});
const WHEN = [{ path: "$.kind", equals: "adjustment" }];

async function makeRule(name: string, when: unknown, ageDays: number): Promise<string> {
  const out = (await h.runStepUp(h.admin, "accounting.posting_rule.create", { event: EVENT, name, journalId, template: template(when) })) as { id: string };
  // created_at is immutable by trigger; the test ages the rule with triggers off inside one transaction.
  await h.sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update accounting.posting_rules set created_at = now() - make_interval(days => ${ageDays}), updated_at = now() - make_interval(days => ${ageDays}) where id = ${out.id}`;
  });
  return out.id;
}
const emit = (payload: unknown, ageDays = 1) =>
  h.sql`insert into kernel.outbox (company_id, event, payload, chain_id, created_at) values (${h.companyId}, ${EVENT}, ${h.sql.json(payload as never)}, ${randomUUID()}, now() - make_interval(days => ${ageDays}))`;
const stale = async (id: string) => ((await h.run(h.admin, "accounting.posting_rule.consult", { id })) as { stale: boolean }).stale;

describe("posting_rule.consult stale flag", () => {
  it("is true for an old active rule with a when and no events, false once a matching event arrives", async () => {
    const id = await makeRule("Stale uno", WHEN, 40);
    expect(await stale(id)).toBe(true);
    await emit({ kind: "adjustment", total: 1 });
    expect(await stale(id)).toBe(false);
  });

  it("stays true when the only recent events do not satisfy the when", async () => {
    const id = await makeRule("Stale dos", [{ path: "$.kind", equals: "never_happens" }], 40);
    await emit({ kind: "other", total: 1 });
    expect(await stale(id)).toBe(true);
  });

  it("a matching event older than N days does not count", async () => {
    const id = await makeRule("Stale tres", [{ path: "$.kind", equals: "ancient" }], 90);
    await emit({ kind: "ancient", total: 1 }, 50);
    expect(await stale(id)).toBe(true);
  });

  it("is false for a rule without when, an inactive rule and a rule younger than N days", async () => {
    expect(await stale(await makeRule("Sin when", undefined, 40))).toBe(false);
    const off = await makeRule("Apagada", [{ path: "$.kind", equals: "zzz" }], 40);
    await h.runStepUp(h.admin, "accounting.posting_rule.disable", { id: off });
    expect(await stale(off)).toBe(false);
    expect(await stale(await makeRule("Joven", [{ path: "$.kind", equals: "yyy" }], 5))).toBe(false);
  });

  it("follows the configured N: a 40-day-old rule is not stale when N is 60", async () => {
    const id = await makeRule("Segun N", [{ path: "$.kind", equals: "xxx" }], 40);
    expect(await stale(id)).toBe(true);
    await h.runStepUp(h.admin, "accounting.settings.update", { ruleStaleDays: 60 });
    expect(await stale(id)).toBe(false);
    await h.runStepUp(h.admin, "accounting.settings.update", { ruleStaleDays: 30 });
  });

  it("ignores other companies' events", async () => {
    const id = await makeRule("Ajena", [{ path: "$.kind", equals: "foreign" }], 40);
    await h.sql`insert into kernel.outbox (company_id, event, payload, chain_id) values (${randomUUID()}, ${EVENT}, ${h.sql.json({ kind: "foreign" })}, ${randomUUID()})`.catch(() => undefined);
    expect(await stale(id)).toBe(true);
  });

  it("a rule the admin just edited is not stale at once (the later of created_at and updated_at counts)", async () => {
    const id = await makeRule("Editada", [{ path: "$.kind", equals: "edited" }], 40);
    expect(await stale(id)).toBe(true);
    await h.runStepUp(h.admin, "accounting.posting_rule.update", { id, priority: 101 });
    expect(await stale(id)).toBe(false);
  });

  it("the outbox has an index on (company_id, event, created_at) for the scan, and nested when paths still work", async () => {
    const [idx] = await h.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where schemaname = 'kernel' and tablename = 'outbox' and indexname = 'outbox_company_event_created_idx'`;
    expect(idx?.indexdef).toMatch(/company_id, event, created_at DESC/);
    const id = await makeRule("Anidada", [{ path: "$.a.b", equals: 7 }], 40);
    await emit({ a: { b: 7 }, big: "x".repeat(1000) });
    expect(await stale(id)).toBe(false);
  });
});
