import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { FatalError } from "workflow";
import { z } from "zod";
import { seedTenant, testDb, type SeededTenant } from "../db/test-db";
import { consumers, SYSTEM_USER_ID } from "../events/consumers";
import { drainOutbox } from "../events/drain";
import { enqueueEvent } from "../events/outbox";
import { defineModule } from "../module/define";
import { loadModules } from "../module/loader";
import { defineProcess } from "../process/define";
import { registry } from "../registry";

const sql = testDb();
const WAIT = { timeout: 20_000, interval: 100 };

describe("outbox dispatch", () => {
  let seed: SeededTenant;
  let companyId: string;

  /** Enqueues an event in its own transaction and returns the chain id it carries. */
  const enqueue = async (event: string, payload: unknown = {}) => {
    const chainId = randomUUID();
    await sql.begin((tx) => enqueueEvent(tx, { companyId, event, payload, chainId }));
    return chainId;
  };
  const outboxRow = async (chainId: string) => (await sql`select * from kernel.outbox where chain_id = ${chainId}`)[0];
  const deadLetter = async (chainId: string) => (await sql`select * from kernel.outbox_dead_letter where chain_id = ${chainId}`)[0];

  beforeAll(async () => {
    // Rows other test files left behind for companies that no longer exist would be drained too.
    await sql`delete from kernel.outbox o where not exists (select 1 from kernel.companies c where c.id = o.company_id)`;
    seed = await seedTenant(sql, { companies: 1 });
    companyId = seed.companies[0]!.id;
  });

  afterEach(async () => {
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await sql`delete from kernel.outbox_dead_letter where company_id = ${companyId}`;
    await sql`delete from kernel.company_modules where company_id = ${companyId}`;
  });

  afterAll(async () => {
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.audit_log where company_id = ${companyId}`.catch(() => undefined);
    await seed.cleanup();
    await sql.end();
  });

  it("drains the outbox and runs consumers with the same chain id", async () => {
    const seen: string[] = [];
    consumers.register("test", "test.probe.created", async (ctx) => {
      seen.push(ctx.chainId);
    });
    const chainId = await enqueue("test.probe.created");

    const n = await drainOutbox(sql);
    expect(n).toBe(1);

    await vi.waitFor(async () => expect((await outboxRow(chainId))!.dispatched_at).not.toBeNull(), WAIT);
    expect(seen).toEqual([chainId]);
    expect((await outboxRow(chainId))!.last_error).toBeNull();
    // A dispatched row is never claimed again.
    expect(await drainOutbox(sql)).toBe(0);
  });

  it("a FatalError moves the row to the dead letter table", async () => {
    consumers.register("test", "test.probe.fatal", async () => {
      throw new FatalError("boom: cannot be processed");
    });
    const chainId = await enqueue("test.probe.fatal", { n: 1 });

    expect(await drainOutbox(sql)).toBe(1);

    await vi.waitFor(async () => expect(await deadLetter(chainId)).toBeDefined(), WAIT);
    const dead = (await deadLetter(chainId))!;
    expect(dead.event).toBe("test.probe.fatal");
    expect(dead.payload).toEqual({ n: 1 });
    expect(dead.last_error).toContain("boom: cannot be processed");
    expect(dead.failed_at).not.toBeNull();
    // Dead-lettered rows leave the outbox.
    expect(await outboxRow(chainId)).toBeUndefined();
  });

  it("a transient error is retried, counting the attempt, until the consumer succeeds", async () => {
    let calls = 0;
    consumers.register("test", "test.probe.flaky", async () => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset");
    });
    const chainId = await enqueue("test.probe.flaky");

    expect(await drainOutbox(sql)).toBe(1);

    await vi.waitFor(async () => expect((await outboxRow(chainId))!.dispatched_at).not.toBeNull(), WAIT);
    expect(calls).toBe(2);
    const row = (await outboxRow(chainId))!;
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("connection reset");
    expect(await deadLetter(chainId)).toBeUndefined();
  });

  it("consumers of a disabled module are skipped and the row is retried once it is enabled", async () => {
    const seen: string[] = [];
    consumers.register("paused", "test.probe.paused", async (ctx) => {
      seen.push(ctx.chainId);
    });
    await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, 'paused', false)`;
    const chainId = await enqueue("test.probe.paused");

    expect(await drainOutbox(sql)).toBe(1);
    await vi.waitFor(async () => expect((await outboxRow(chainId))!.last_error).toBe("module_disabled"), WAIT);
    expect((await outboxRow(chainId))!.dispatched_at).toBeNull();
    expect(seen).toEqual([]);

    // While the module stays disabled the row is not claimed again.
    expect(await drainOutbox(sql)).toBe(0);

    await sql`update kernel.company_modules set enabled = true where company_id = ${companyId} and module_id = 'paused'`;
    expect(await drainOutbox(sql)).toBe(1);
    await vi.waitFor(async () => expect((await outboxRow(chainId))!.dispatched_at).not.toBeNull(), WAIT);
    expect(seen).toEqual([chainId]);
    expect((await outboxRow(chainId))!.last_error).toBeNull();
  });

  it("modules loaded through loadModules consume events, and ctx.runProcess runs as the system user on the same chain", async () => {
    const touch = defineProcess({
      id: "dispatchprobe.thing.touch",
      module: "dispatchprobe",
      kind: "create",
      description: "prueba",
      input: z.object({ note: z.string() }),
      output: z.object({}),
      handler: async (ctx, input) => {
        await ctx.emit("dispatchprobe.thing.touched", input);
        return {};
      },
    });
    loadModules(registry, [
      defineModule({
        id: "dispatchprobe",
        version: "1",
        dependsOn: [],
        entities: [],
        processes: [touch],
        features: [],
        events: {
          emits: ["dispatchprobe.thing.touched"],
          consumes: {
            "dispatchprobe.thing.requested": async (ctx, payload) => {
              await ctx.runProcess("dispatchprobe.thing.touch", payload);
            },
          },
        },
        navigation: [],
      }),
    ]);
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${seed.tenantId}, 'module:dispatchprobe', 'manual')`;
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
      values (${companyId}, ${seed.companies[0]!.adminRoleId}, 'dispatchprobe.thing.touch')`;
    const chainId = await enqueue("dispatchprobe.thing.requested", { note: "hola" });

    expect(await drainOutbox(sql)).toBe(1);

    const requested = async () => (await sql`select dispatched_at from kernel.outbox where chain_id = ${chainId} and event = 'dispatchprobe.thing.requested'`)[0];
    await vi.waitFor(async () => expect((await requested())!.dispatched_at).not.toBeNull(), WAIT);
    const [audit] = await sql`select * from kernel.audit_log where company_id = ${companyId} and process_id = 'dispatchprobe.thing.touch'`;
    expect(audit).toMatchObject({ origin: "event", actor_user_id: SYSTEM_USER_ID, chain_id: chainId, action: "insert" });
    // The process's own event joined the chain, so the next hop is traceable.
    const [emitted] = await sql`select payload, chain_id from kernel.outbox where company_id = ${companyId} and event = 'dispatchprobe.thing.touched'`;
    expect(emitted).toMatchObject({ payload: { note: "hola" }, chain_id: chainId });
  });
});
