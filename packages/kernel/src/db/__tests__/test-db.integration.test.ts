import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { enqueueEvent } from "../../events/outbox";
import { seedTenant, testDb } from "../test-db";

// Test isolation of the shared outbox (Task 21): every suite seeds its own tenant and drains or leaves outbox rows for
// its companies. `drainOutbox` claims rows of every company, so rows a suite left behind would be dispatched by the
// next suite that drains (dispatch.integration.test.ts). The seed's cleanup takes its companies' outbox rows with it.

const sql = testDb();
afterAll(() => sql.end());

describe("seedTenant cleanup", () => {
  it("removes the outbox rows, deliveries and dead letters of its companies, and nobody else's", async () => {
    const mine = await seedTenant(sql, { companies: 2 });
    const other = await seedTenant(sql, { companies: 1 });
    const ids = mine.companies.map((c) => c.id);
    try {
      const enqueue = (companyId: string) =>
        sql.begin((tx) => enqueueEvent(tx, { companyId, event: "test.isolation.probe", payload: {}, chainId: randomUUID() }));
      const delivered = await enqueue(ids[0]!);
      await enqueue(ids[1]!);
      const others = await enqueue(other.companies[0]!.id);
      await sql`insert into kernel.outbox_deliveries(outbox_id, module_id) values (${delivered}, 'test')`;
      await sql`insert into kernel.outbox_dead_letter(company_id, event, payload, chain_id) values (${ids[1]!}, 'test.isolation.probe', '{}', ${randomUUID()})`;

      await mine.cleanup();

      const [left] = await sql<{ outbox: number; dead: number; deliveries: number }[]>`
        select (select count(*)::int from kernel.outbox where company_id = any(${ids}::uuid[])) as outbox,
               (select count(*)::int from kernel.outbox_dead_letter where company_id = any(${ids}::uuid[])) as dead,
               (select count(*)::int from kernel.outbox_deliveries where outbox_id = ${delivered}) as deliveries`;
      expect(left).toEqual({ outbox: 0, dead: 0, deliveries: 0 });
      expect(await sql`select id from kernel.outbox where id = ${others}`).toHaveLength(1);
    } finally {
      await sql`delete from kernel.outbox where company_id = ${other.companies[0]!.id}`;
      await other.cleanup();
    }
  });
});
