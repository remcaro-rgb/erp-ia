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
import type { EventConsumer } from "../registry/types";

const sql = testDb();
const WAIT = { timeout: 30_000, interval: 100 };
// The registry is process-wide: every run of this file registers modules under fresh ids.
const run = randomUUID().slice(0, 8);
const ids = { main: `dsp_main_${run}`, paused: `dsp_paused_${run}`, a: `dsp_a_${run}`, b: `dsp_b_${run}`, wild: `dsp_wild_${run}` };

/** Consumer behaviour set by each test, by event or (more specific) by `<module>/<event>`; the stub modules forward to it. */
let handlers: Record<string, EventConsumer> = {};
const forward = (moduleId: string, events: string[]) =>
  Object.fromEntries(
    events.map((event) => [event, ((ctx, payload) => (handlers[`${moduleId}/${event}`] ?? handlers[event]!)(ctx, payload)) as EventConsumer]),
  );

const stub = (id: string, events: string[], processes: ReturnType<typeof defineProcess>[] = []) =>
  defineModule({
    id,
    version: "1",
    dependsOn: [],
    entities: [],
    processes,
    features: [],
    events: { emits: [], consumes: forward(id, events) },
    navigation: [],
  });

describe("outbox dispatch without modules", () => {
  it("refuses to drain when no module is loaded", async () => {
    expect(registry.modules()).toHaveLength(0);
    await expect(drainOutbox(sql)).rejects.toThrow("outbox: no modules loaded");
  });
});

describe("outbox dispatch", () => {
  let seed: SeededTenant;
  let companyId: string;
  const touch = defineProcess({
    id: `${ids.main}.thing.touch`,
    module: ids.main,
    kind: "create",
    description: "prueba",
    input: z.object({ note: z.string() }),
    output: z.object({}),
    handler: async (ctx, input) => {
      await ctx.emit("test.probe.touched", input);
      return {};
    },
  });

  /** Enqueues an event in its own transaction and returns the chain id it carries. */
  const enqueue = async (event: string, payload: unknown = {}) => {
    const chainId = randomUUID();
    await sql.begin((tx) => enqueueEvent(tx, { companyId, event, payload, chainId }));
    return chainId;
  };
  const outboxRow = async (chainId: string, event?: string) =>
    (await sql`select * from kernel.outbox where chain_id = ${chainId} and (${event ?? null}::text is null or event = ${event ?? null})`)[0];
  const deadLetter = async (chainId: string) => (await sql`select * from kernel.outbox_dead_letter where chain_id = ${chainId}`)[0];
  // The suite drains only its own company's rows: rows another suite, a crashed run or someone using the app left in
  // the shared outbox are neither claimed nor counted.
  const drain = () => drainOutbox(sql, 100, { companyIds: [companyId] });
  const isDispatched = (chainId: string, event?: string) => async () =>
    expect((await outboxRow(chainId, event))!.dispatched_at).not.toBeNull();

  beforeAll(async () => {
    // Rows other test files left behind for companies that no longer exist would be drained too.
    await sql`delete from kernel.outbox o where not exists (select 1 from kernel.companies c where c.id = o.company_id)`;
    seed = await seedTenant(sql, { companies: 1 });
    companyId = seed.companies[0]!.id;
    loadModules(registry, [
      stub(
        ids.main,
        [
          "test.probe.created",
          "test.probe.fatal",
          "test.probe.flaky",
          "test.probe.exhausted",
          "test.probe.gated",
          "test.probe.refused",
          "test.probe.requested",
          "test.probe.shared",
        ],
        [touch],
      ),
      stub(ids.paused, ["test.probe.paused"]),
      stub(ids.a, ["test.probe.partial"]),
      stub(ids.b, ["test.probe.partial"]),
    ]);
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${seed.tenantId}, ${`module:${ids.main}`}, 'manual')`;
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
      values (${companyId}, ${seed.companies[0]!.adminRoleId}, ${touch.id})`;
  });

  afterEach(async () => {
    handlers = {};
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await sql`delete from kernel.outbox_dead_letter where company_id = ${companyId}`;
    await sql`delete from kernel.company_modules where company_id = ${companyId}`;
  });

  afterAll(async () => {
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await seed.cleanup();
    await sql.end();
  });

  it("drains the outbox and runs consumers with the same chain id", async () => {
    const seen: string[] = [];
    handlers["test.probe.created"] = async (ctx) => {
      seen.push(ctx.chainId);
    };
    const chainId = await enqueue("test.probe.created");

    const n = await drain();
    expect(n).toBe(1);

    await vi.waitFor(isDispatched(chainId), WAIT);
    expect(seen).toEqual([chainId]);
    expect((await outboxRow(chainId))!.last_error).toBeNull();
    // A dispatched row is never claimed again.
    expect(await drain()).toBe(0);
  });

  it("a FatalError moves the row to the dead letter table", async () => {
    handlers["test.probe.fatal"] = async () => {
      throw new FatalError("boom: cannot be processed");
    };
    const chainId = await enqueue("test.probe.fatal", { n: 1 });

    expect(await drain()).toBe(1);

    await vi.waitFor(async () => expect(await deadLetter(chainId)).toBeDefined(), WAIT);
    const dead = (await deadLetter(chainId))!;
    expect(dead.event).toBe("test.probe.fatal");
    expect(dead.payload).toEqual({ n: 1 });
    expect(dead.last_error).toContain("boom: cannot be processed");
    expect(dead.failed_at).not.toBeNull();
    // Dead-lettered rows leave the outbox.
    expect(await outboxRow(chainId)).toBeUndefined();
  });

  it("a process refusal that cannot change is dead-lettered without burning retries", async () => {
    handlers["test.probe.refused"] = async (ctx) => {
      await ctx.runProcess("nobody.thing.exists", {});
    };
    const chainId = await enqueue("test.probe.refused");

    expect(await drain()).toBe(1);

    await vi.waitFor(async () => expect(await deadLetter(chainId)).toBeDefined(), WAIT);
    const dead = (await deadLetter(chainId))!;
    expect(dead.last_error).toContain("not_found");
    expect(dead.attempts).toBe(0);
  });

  it("a transient error is retried, counting the attempt, until the consumer succeeds", async () => {
    let calls = 0;
    handlers["test.probe.flaky"] = async () => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset");
    };
    const chainId = await enqueue("test.probe.flaky");

    expect(await drain()).toBe(1);

    await vi.waitFor(isDispatched(chainId), WAIT);
    expect(calls).toBe(2);
    const row = (await outboxRow(chainId))!;
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("connection reset");
    expect(await deadLetter(chainId)).toBeUndefined();
  });

  it("a consumer that keeps failing is dead-lettered once its retries are exhausted", async () => {
    let calls = 0;
    handlers["test.probe.exhausted"] = async () => {
      calls += 1;
      throw new Error("still down");
    };
    const chainId = await enqueue("test.probe.exhausted");

    expect(await drain()).toBe(1);

    await vi.waitFor(async () => expect(await deadLetter(chainId)).toBeDefined(), WAIT);
    // The first run plus the step's 3 retries.
    expect(calls).toBe(4);
    const dead = (await deadLetter(chainId))!;
    expect(dead.attempts).toBe(4);
    expect(dead.last_error).toContain("still down");
    expect(await outboxRow(chainId)).toBeUndefined();
  });

  it("consumers of a disabled module are skipped and the row is retried once it is enabled", async () => {
    const seen: string[] = [];
    handlers["test.probe.paused"] = async (ctx) => {
      seen.push(ctx.chainId);
    };
    await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, ${ids.paused}, false)`;
    const chainId = await enqueue("test.probe.paused");

    expect(await drain()).toBe(1);
    await vi.waitFor(async () => expect((await outboxRow(chainId))!.last_error).toBe("module_disabled"), WAIT);
    expect((await outboxRow(chainId))!.dispatched_at).toBeNull();
    expect(seen).toEqual([]);

    // While the module stays disabled the row is not claimed again.
    expect(await drain()).toBe(0);

    await sql`update kernel.company_modules set enabled = true where company_id = ${companyId} and module_id = ${ids.paused}`;
    expect(await drain()).toBe(1);
    await vi.waitFor(isDispatched(chainId), WAIT);
    expect(seen).toEqual([chainId]);
    expect((await outboxRow(chainId))!.last_error).toBeNull();
  });

  it("a re-dispatch after re-enabling a module runs only the consumers without a delivery", async () => {
    const calls: string[] = [];
    expect(consumers.for("test.probe.partial").map((c) => c.moduleId)).toEqual([ids.a, ids.b]);
    handlers[`${ids.a}/test.probe.partial`] = async () => void calls.push("a");
    handlers[`${ids.b}/test.probe.partial`] = async () => void calls.push("b");
    await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, ${ids.b}, false)`;
    const chainId = await enqueue("test.probe.partial");

    expect(await drain()).toBe(1);
    await vi.waitFor(async () => expect((await outboxRow(chainId))!.last_error).toBe("module_disabled"), WAIT);
    expect(calls).toEqual(["a"]);
    const delivered = await sql`select module_id from kernel.outbox_deliveries where outbox_id = ${(await outboxRow(chainId))!.id}`;
    expect(delivered.map((r) => r.module_id)).toEqual([ids.a]);

    await sql`update kernel.company_modules set enabled = true where company_id = ${companyId} and module_id = ${ids.b}`;
    expect(await drain()).toBe(1);
    await vi.waitFor(isDispatched(chainId), WAIT);
    expect(calls).toEqual(["a", "b"]);
  });

  it("overlapping drains do not start a second workflow for a claimed row", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    handlers["test.probe.gated"] = async () => {
      calls += 1;
      await gate;
    };
    const chainId = await enqueue("test.probe.gated");

    expect(await drain()).toBe(1);
    await vi.waitFor(() => expect(calls).toBe(1), WAIT);
    expect((await outboxRow(chainId))!.claimed_at).not.toBeNull();
    // In flight, within the claim window: neither drain claims it again.
    expect(await drain()).toBe(0);
    expect(await Promise.all([drain(), drain()])).toEqual([0, 0]);

    release();
    await vi.waitFor(isDispatched(chainId), WAIT);
    expect(calls).toBe(1);

    // A claim older than the window is void: a lost run is picked up again.
    handlers["test.probe.gated"] = async () => {
      calls += 1;
    };
    const lost = await enqueue("test.probe.gated");
    await sql`update kernel.outbox set claimed_at = now() - interval '11 minutes' where chain_id = ${lost}`;
    expect(await drain()).toBe(1);
    await vi.waitFor(isDispatched(lost), WAIT);
    expect(calls).toBe(2);
  });

  it("a drain scoped to its companies leaves every other company's undispatched rows alone", async () => {
    const strayCompany = randomUUID();
    const [stray] = await sql<{ id: string }[]>`
      insert into kernel.outbox(company_id, event, payload, chain_id) values (${strayCompany}, 'test.probe.stray', '{}', ${randomUUID()}) returning id`;
    try {
      handlers["test.probe.created"] = async () => {};
      const chainId = await enqueue("test.probe.created");
      expect(await drain()).toBe(1);
      await vi.waitFor(isDispatched(chainId), WAIT);
      const [left] = await sql<{ claimed_at: Date | null; dispatched_at: Date | null }[]>`select claimed_at, dispatched_at from kernel.outbox where id = ${stray!.id}`;
      expect(left).toEqual({ claimed_at: null, dispatched_at: null });
    } finally {
      await sql`delete from kernel.outbox where id = ${stray!.id}`;
    }
  });

  it("loadModules registered the consumers, and ctx.runProcess runs as the system user on the same chain", async () => {
    expect(consumers.for("test.probe.requested").map((c) => c.moduleId)).toEqual([ids.main]);
    handlers["test.probe.requested"] = async (ctx, payload) => {
      await ctx.runProcess(touch.id, payload);
    };
    const chainId = await enqueue("test.probe.requested", { note: "hola" });

    expect(await drain()).toBe(1);

    await vi.waitFor(isDispatched(chainId, "test.probe.requested"), WAIT);
    const [audit] = await sql`select * from kernel.audit_log where company_id = ${companyId} and process_id = ${touch.id}`;
    expect(audit).toMatchObject({ origin: "event", actor_user_id: SYSTEM_USER_ID, chain_id: chainId, action: "insert" });
    // The process's own event joined the chain, so the next hop is traceable.
    const emitted = await outboxRow(chainId, "test.probe.touched");
    expect(emitted).toMatchObject({ payload: { note: "hola" }, chain_id: chainId });
  });

  it("wildcard consumer runs after the specific one and is parked while its module is disabled", async () => {
    // Registered here, last: a wildcard consumer sees every event and would change what the other tests assert.
    loadModules(registry, [defineModule({
      id: ids.wild,
      version: "1",
      dependsOn: [],
      entities: [],
      processes: [],
      features: [],
      events: { emits: [], consumes: { "*": async (ctx, payload) => handlers[`${ids.wild}/*`]?.(ctx, payload) } },
      navigation: [],
    })]);
    const calls: string[] = [];
    expect(consumers.for("test.probe.partial").map((c) => c.moduleId)).toEqual([ids.a, ids.b, ids.wild]);
    handlers[`${ids.a}/test.probe.partial`] = async () => void calls.push("a");
    handlers[`${ids.b}/test.probe.partial`] = async () => void calls.push("b");
    handlers[`${ids.wild}/*`] = async () => void calls.push("wild");
    await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, ${ids.wild}, false)`;
    const chainId = await enqueue("test.probe.partial");

    expect(await drain()).toBe(1);
    await vi.waitFor(async () => expect((await outboxRow(chainId))!.last_error).toBe("module_disabled"), WAIT);
    expect(calls).toEqual(["a", "b"]);
    // Parked: the drain skips it while the wildcard module stays disabled.
    expect(await drain()).toBe(0);

    await sql`update kernel.company_modules set enabled = true where company_id = ${companyId} and module_id = ${ids.wild}`;
    expect(await drain()).toBe(1);
    await vi.waitFor(isDispatched(chainId), WAIT);
    expect(calls).toEqual(["a", "b", "wild"]);
  });
});
