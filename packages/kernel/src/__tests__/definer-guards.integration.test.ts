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
// they work as before, and a session without a user (the service role, migrations) is not affected. The recommendation writers of 0123
// (kernel.recommendation_raise / _close) refuse any session that is not the run of the process they name, and so do the document link
// writers of 0124 (kernel.document_link_sync / _mark_voided, through kernel.document_link_writer, plan 2B Task 31).

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
    // The recommendation writers (0123, plan 2B Task 38) also refuse a run of another process than the one named.
    const raise = (tx: Tx, processId: string) =>
      tx`select * from kernel.recommendation_raise(${processId}, ${processId}, null, 'kernel.guard', ${randomUUID()}::uuid, 'guard', 't', 'b', '{}'::jsonb)`;
    await expect(asUser(null, (tx) => raise(tx, "kernel.recommendation.decide"))).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
    await expect(asUser("kernel.user_prefs.set", (tx) => raise(tx, "kernel.recommendation.decide"))).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
    await expect(asUser(null, (tx) => tx`select kernel.recommendation_close('kernel.recommendation.decide', 'kernel.guard', ${randomUUID()}::uuid, null)`)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
    // The document link writers (0124, plan 2B Task 31) refuse a session that is not the run of the process they name.
    const linkSync = (tx: Tx, processId: string) =>
      tx`select * from kernel.document_link_sync(${processId}, 'kernel.guard', ${randomUUID()}::uuid, 'guard_to_guard', '[]'::jsonb)`;
    for (const [running, named] of [[null, "kernel.recommendation.decide"], ["kernel.user_prefs.set", "kernel.recommendation.decide"]] as const) {
      await expect(asUser(running, (tx) => linkSync(tx, named))).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
      await expect(asUser(running, (tx) => tx`select kernel.document_link_mark_voided(${named}, 'kernel.guard', ${randomUUID()}::uuid, null)`)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
    }
    // The gate itself is not callable by a user session at all.
    await expect(asUser("kernel.recommendation.decide", (tx) => tx`select kernel.document_link_writer('kernel.recommendation.decide', 'kernel.guard')`)).rejects.toMatchObject({ code: "42501" });
    // The trail reads as the caller (security invoker): it is no definer function and needs no process.
    const [trail] = await sql<{ definer: boolean }[]>`select prosecdef as definer from pg_proc where oid = 'kernel.document_trail(text, uuid, text, integer, integer)'::regprocedure`;
    expect(trail!.definer).toBe(false);
    // Every new definer function pins its search_path and is not executable by anon.
    const definers = await sql<{ name: string; config: string[] | null; anon: boolean; authenticated: boolean }[]>`
      select p.proname as name, p.proconfig as config, has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'kernel' and p.prosecdef
        and p.proname in ('document_link_writer', 'document_link_record', 'document_link_sync', 'document_link_mark_voided', 'document_link_step',
                          'entity_entitled', 'entity_consult_processes', 'document_visible', 'document_trail')`;
    expect(definers.map((d) => d.name).sort()).toEqual(["document_link_mark_voided", "document_link_record", "document_link_step", "document_link_sync", "document_link_writer", "entity_entitled"]);
    for (const d of definers) {
      expect(d.config, d.name).toContain("search_path=\"\"");
      expect(d.anon, d.name).toBe(false);
    }
    // The gate and the record reader are internal to the writers: a user session cannot call them.
    expect(definers.filter((d) => !d.authenticated).map((d) => d.name).sort()).toEqual(["document_link_record", "document_link_writer"]);
    await expect(asUser("kernel.recommendation.decide", (tx) => tx`select * from kernel.document_link_record('kernel.guard', ${randomUUID()}::uuid, ${companyId}::uuid)`)).rejects.toMatchObject({ code: "42501" });
    // The trail's step reads the links only inside a run of the trail.
    for (const running of [null, "kernel.recommendation.decide"]) {
      await expect(asUser(running, (tx) => tx`select * from kernel.document_link_step('down', '{}'::text[], '{}'::uuid[])`)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(GUARDED) });
    }
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
    // A registered update process naming itself raises and closes (rolled back; the process row exists only inside the transaction).
    const raised = await asUser("test.guard.recommend", async (tx) => {
      const subject = randomUUID();
      await tx`reset role`;
      await tx`insert into kernel.registered_processes (process_id, module_id, kind) values ('test.guard.recommend', 'test', 'update')`;
      await tx`set local role authenticated`;
      const [r] = await tx<{ merged: boolean }[]>`
        select merged from kernel.recommendation_raise('test.guard.recommend', 'test.guard.recommend', null, 'test.guard', ${subject}::uuid, 'guard', 't', 'b', '{}'::jsonb)`;
      const [c] = await tx<{ n: number }[]>`select kernel.recommendation_close('test.guard.recommend', 'test.guard', ${subject}::uuid, null) as n`;
      return { merged: r!.merged, closed: c!.n };
    });
    expect(raised).toEqual({ merged: false, closed: 1 });
    // The link writers under a registered update naming itself pass the gate (it then refuses the unknown entity: invalid input).
    const linked = asUser("test.guard.recommend", async (tx) => {
      await tx`reset role`;
      await tx`insert into kernel.registered_processes (process_id, module_id, kind) values ('test.guard.recommend', 'test', 'update')`;
      await tx`set local role authenticated`;
      return tx`select * from kernel.document_link_sync('test.guard.recommend', 'test.guard', ${randomUUID()}::uuid, 'guard_to_guard', '[]'::jsonb)`;
    });
    await expect(linked).rejects.toMatchObject({ code: "22023" });

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
