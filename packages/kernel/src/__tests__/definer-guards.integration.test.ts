import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JwtClaims, Tx } from "../db/client";
import { testDb, seedTenant } from "../db/test-db";
import { enqueueEvent } from "../events/outbox";
import { defineProcess } from "../process/define";
import { runProcess } from "../process/run";
import { registry } from "../registry";

// Final review M-1 (migration 0116, rule 1): the SECURITY DEFINER functions that consume a number or mark, dismiss or lock an event refuse
// a user session outside a process run (erp.audit_process_id empty, or not an invoicing process for a DIAN number). Inside a process run
// they work as before, and a session without a user (the service role, migrations) is not affected.

const GUARDED = /only inside a process run/;
const COUNTERS = ["inventory.next_movement_number", "crm.next_number", "sales.next_number", "costing.next_document_number", "payments.next_document_number"];

describe("process guards of the definer functions (migration 0116)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let companyId: string;
  let claims: JwtClaims;
  const rollback = new Error("rollback");

  /** Runs `fn` as the seeded user (authenticated, the company active), optionally attributed to `processId` as runProcess does; rolled back. */
  async function asUser<T>(processId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    let out: T | undefined;
    await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...claims })}, true), set_config('role', 'authenticated', true)`;
      if (processId) await tx`select set_config('erp.audit_process_id', ${processId}, true)`;
      out = await fn(tx as unknown as Tx);
      throw rollback;
    }).catch((e: unknown) => { if (e !== rollback) throw e; });
    return out as T;
  }
  const event = () => enqueueEvent(sql as unknown as Tx, { companyId, event: "test.guard.happened", payload: { guard: "m1" }, chainId: randomUUID() });

  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, { companies: 1, users: [] });
    companyId = seed.companies[0]!.id;
    claims = seed.claimsFor(seed.users.both, companyId) as JwtClaims;
  });
  afterAll(async () => {
    await sql`delete from kernel.outbox_deliveries where outbox_id in (select id from kernel.outbox where company_id = ${companyId})`;
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await seed.cleanup();
    await sql.end();
  });

  it("refuses a user session outside a process run", async () => {
    const id = await event();
    for (const fn of COUNTERS) {
      await expect(asUser(null, (tx) => tx.unsafe(`select ${fn}($1::uuid, 'G-') as n`, [companyId])), fn).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
    }
    await expect(asUser(null, (tx) => tx`select core.next_document_number(${companyId}::uuid, 'invoice', current_date)`)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
    await expect(asUser(null, (tx) => tx`select kernel.mark_event_handled(${id}::uuid, 'accounting')`)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
    await expect(asUser(null, (tx) => tx`select kernel.dismiss_events('accounting', 'test.guard.happened', '{"guard":"m1"}'::jsonb)`)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
    await expect(asUser(null, (tx) => tx`select kernel.lock_event_for(${id}::uuid, 'accounting')`)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
    // A DIAN number needs an invoicing process: another module's process is refused.
    await expect(asUser("sales.order.confirm", (tx) => tx`select core.next_document_number(${companyId}::uuid, 'invoice', current_date)`)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
  });

  it("works inside a process run as before", async () => {
    const id = await event();
    for (const fn of COUNTERS) {
      const [row] = await asUser("test.guard.process", (tx) => tx.unsafe(`select ${fn}($1::uuid, 'G-') as n`, [companyId]));
      expect(row!.n, fn).toBe("G-1");
    }
    // No numbering row in this company: the draw answers so (it is not refused).
    const [drawn] = await asUser("invoicing.invoice.issue", (tx) => tx<{ r: { status: string } }[]>`select core.next_document_number(${companyId}::uuid, 'invoice', current_date) as r`);
    expect(drawn!.r).toEqual({ status: "no_resolution" });
    const marked = await asUser("invoicing.invoice.issue", async (tx) => {
      await tx`select kernel.mark_event_handled(${id}::uuid, 'accounting')`;
      const [locked] = await tx<{ handled: boolean }[]>`select kernel.lock_event_for(${id}::uuid, 'accounting') as handled`;
      return locked!.handled;
    });
    expect(marked).toBe(true);
    const [dismissed] = await asUser("payments.receipt.void", (tx) => tx<{ n: number }[]>`select kernel.dismiss_events('accounting', 'test.guard.happened', '{"guard":"m1"}'::jsonb) as n`);
    expect(dismissed!.n).toBeGreaterThanOrEqual(1);

    // The same through a real run: runProcess attributes the transaction to the process.
    const probe = defineProcess({
      id: "test.guard.run",
      module: "test",
      kind: "update",
      recordAccess: "none",
      description: "proceso de prueba de los guardas",
      input: z.object({ eventId: z.string() }),
      output: z.object({ number: z.string(), handled: z.boolean() }),
      handler: async (ctx, input) => {
        const [n] = await ctx.tx<{ n: string }[]>`select sales.next_number(${ctx.companyId}::uuid, 'GR-') as n`;
        const [l] = await ctx.tx<{ handled: boolean }[]>`select kernel.lock_event_for(${input.eventId}::uuid, 'accounting') as handled`;
        return { number: n!.n, handled: l!.handled };
      },
    });
    registry.registerProcess(probe);
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.adminRoleId}, 'test.guard.run') on conflict do nothing`;
    try {
      const out = await runProcess({ sql, registry }, { claims, origin: "ui" }, "test.guard.run", { eventId: await event() });
      expect(out).toMatchObject({ number: expect.stringMatching(/^GR-\d+$/), handled: false });
    } finally {
      await sql`delete from kernel.process_permissions where company_id = ${companyId} and process_id = 'test.guard.run'`;
      await sql`delete from sales.document_numbers where company_id = ${companyId}`;
    }
  });

  it("a session without a user (service role, migrations) is not refused", async () => {
    await sql.begin(async (tx) => {
      for (const fn of COUNTERS) {
        const [row] = await tx.unsafe(`select ${fn}($1::uuid, 'S-') as n`, [companyId]);
        expect(row!.n, fn).toBe("S-1");
      }
      const [drawn] = await tx<{ r: { status: string } }[]>`select core.next_document_number(${companyId}::uuid, 'invoice', current_date) as r`;
      expect(drawn!.r).toEqual({ status: "no_resolution" });
      // Without claims there is no active company: the event functions find nothing of it (their company check, unchanged).
      const [locked] = await tx<{ handled: boolean }[]>`select kernel.lock_event_for(${await event()}::uuid, 'accounting') as handled`;
      expect(locked!.handled).toBe(false);
      throw rollback;
    }).catch((e: unknown) => { if (e !== rollback) throw e; });
  });
});
