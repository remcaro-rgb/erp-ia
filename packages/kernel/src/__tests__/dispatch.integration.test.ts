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
import type { PostingProvider } from "../posting/provider";

const sql = testDb();
const WAIT = { timeout: 30_000, interval: 100 };
// The registry is process-wide: every run of this file registers modules under fresh ids.
const run = randomUUID().slice(0, 8);
const ids = { main: `dsp_main_${run}`, paused: `dsp_paused_${run}`, a: `dsp_a_${run}`, b: `dsp_b_${run}`, wild: `dsp_wild_${run}`, wild2: `dsp_wild2_${run}`, unbought: `dsp_unbought_${run}`,
  // Task 52.1: `ta` and `tc` are bought, `tb` never is; registered in the order ta, tb, tc.
  ta: `dsp_ta_${run}`, tb: `dsp_tb_${run}`, tc: `dsp_tc_${run}` };

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
      stub(ids.a, ["test.probe.partial", "test.probe.deliv"]),
      stub(ids.b, ["test.probe.partial"]),
      stub(ids.unbought, ["test.probe.unbought", "test.probe.deliv"]),
      // Task 52.1: test.probe.trio → [ta, tb, tc]; test.probe.ba → [tb, tc] (the unbought one first).
      stub(ids.ta, ["test.probe.trio"]),
      stub(ids.tb, ["test.probe.trio", "test.probe.ba"]),
      stub(ids.tc, ["test.probe.trio", "test.probe.ba"]),
    ]);
    // Task 50.9: the dispatcher asks the entitlement resolver, so every consumer module but `unbought` and `tb` is bought.
    for (const id of [ids.main, ids.paused, ids.a, ids.b, ids.ta, ids.tc]) {
      await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${seed.tenantId}, ${`module:${id}`}, 'manual')`;
    }
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

  it("a consumer of a module the company never bought is dead-lettered not_entitled:<module> without running; a switched-off one stays silent (Task 50.9)", async () => {
    const seen: string[] = [];
    handlers["test.probe.unbought"] = async (ctx) => void seen.push(ctx.chainId);
    const chainId = await enqueue("test.probe.unbought");
    expect(await drain()).toBe(1);
    await vi.waitFor(async () => expect(await deadLetter(chainId)).toBeDefined(), WAIT);
    expect((await deadLetter(chainId))!.last_error).toBe(`not_entitled:${ids.unbought}`);
    expect(await outboxRow(chainId)).toBeUndefined();
    expect(seen).toEqual([]);

    // Bought but switched off: parked silently, nothing dead-lettered.
    handlers["test.probe.paused"] = async () => undefined;
    await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, ${ids.paused}, false)`;
    const parked = await enqueue("test.probe.paused");
    expect(await drain()).toBe(1);
    await vi.waitFor(async () => expect((await outboxRow(parked))!.last_error).toBe("module_disabled"), WAIT);
    expect(await deadLetter(parked)).toBeUndefined();
  });

  it("a module row switched off wins over a lapsed purchase: silent, not dead-lettered", async () => {
    // A module row exists only once the module was enabled; a lapsed plan leaves it off: that is switched off, silent.
    await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, ${ids.unbought}, false)`;
    const chainId = await enqueue("test.probe.unbought");
    expect(await drain()).toBe(1);
    await vi.waitFor(async () => expect((await outboxRow(chainId))!.last_error).toBe("module_disabled"), WAIT);
    expect(await deadLetter(chainId)).toBeUndefined();
  });

  describe("an unbought consumer parks the event only after every other consumer ran (Task 52.1, R52-1)", () => {
    let calls: string[] = [];
    const record = (name: string, event: string, moduleId: string) => {
      handlers[`${moduleId}/${event}`] = async () => void calls.push(name);
    };
    const buyTb = () => sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${seed.tenantId}, ${`module:${ids.tb}`}, 'manual')`;
    const unbuyTb = () => sql`delete from kernel.tenant_entitlements where tenant_id = ${seed.tenantId} and key = ${`module:${ids.tb}`}`;
    const parkedAs = async (chainId: string, moduleId: string) => {
      await vi.waitFor(async () => expect(await deadLetter(chainId)).toBeDefined(), WAIT);
      const dead = (await deadLetter(chainId))!;
      expect(dead.last_error).toBe(`not_entitled:${moduleId}`);
      return dead;
    };

    afterEach(() => {
      calls = [];
    });

    it("(1) [A bought, B never bought, C bought]: A and C run once, the row parks as not_entitled:B with delivered_modules {A, C}", async () => {
      expect(consumers.for("test.probe.trio").map((c) => c.moduleId)).toEqual([ids.ta, ids.tb, ids.tc]);
      record("a", "test.probe.trio", ids.ta);
      record("b", "test.probe.trio", ids.tb);
      record("c", "test.probe.trio", ids.tc);
      const chainId = await enqueue("test.probe.trio");
      expect(await drain()).toBe(1);
      const dead = await parkedAs(chainId, ids.tb);
      expect([...dead.delivered_modules].sort()).toEqual([ids.ta, ids.tc].sort());
      expect(calls).toEqual(["a", "c"]);
      expect(await outboxRow(chainId)).toBeUndefined();
    });

    it("(2) Descartar: the effects of A and C stay, nothing else runs", async () => {
      record("a", "test.probe.trio", ids.ta);
      record("b", "test.probe.trio", ids.tb);
      record("c", "test.probe.trio", ids.tc);
      const chainId = await enqueue("test.probe.trio");
      expect(await drain()).toBe(1);
      await parkedAs(chainId, ids.tb);
      expect((await sql`select kernel.parked_events_dismiss(${companyId}, ${ids.tb}) as n`)[0]!.n).toBe(1);
      expect(await drain()).toBe(0);
      const dead = (await deadLetter(chainId))!;
      expect(dead.dismissed_at).not.toBeNull();
      expect([...dead.delivered_modules].sort()).toEqual([ids.ta, ids.tc].sort());
      expect(calls).toEqual(["a", "c"]);
    });

    it("(3) a replay after B is bought runs only B; the row is dispatched", async () => {
      record("a", "test.probe.trio", ids.ta);
      record("b", "test.probe.trio", ids.tb);
      record("c", "test.probe.trio", ids.tc);
      const chainId = await enqueue("test.probe.trio");
      expect(await drain()).toBe(1);
      await parkedAs(chainId, ids.tb);
      expect(calls).toEqual(["a", "c"]);
      await buyTb();
      try {
        expect(await drain()).toBe(1); // the sweep replayed it, then it was claimed
        await vi.waitFor(isDispatched(chainId), WAIT);
        expect(calls).toEqual(["a", "c", "b"]);
        expect(await deadLetter(chainId)).toBeUndefined();
      } finally {
        await unbuyTb();
      }
    });

    it("(4) [B never bought, C bought]: the unbought one first gives the same result", async () => {
      expect(consumers.for("test.probe.ba").map((c) => c.moduleId)).toEqual([ids.tb, ids.tc]);
      record("b", "test.probe.ba", ids.tb);
      record("c", "test.probe.ba", ids.tc);
      const chainId = await enqueue("test.probe.ba");
      expect(await drain()).toBe(1);
      const dead = await parkedAs(chainId, ids.tb);
      expect(dead.delivered_modules).toEqual([ids.tc]);
      expect(calls).toEqual(["c"]);

      await buyTb();
      try {
        expect(await drain()).toBe(1);
        await vi.waitFor(isDispatched(chainId), WAIT);
        expect(calls).toEqual(["c", "b"]);
      } finally {
        await unbuyTb();
      }
    });

    it("(5) one module switched off plus one unbought: the row pauses, nothing parked; once enabled the row parks", async () => {
      record("a", "test.probe.trio", ids.ta);
      record("b", "test.probe.trio", ids.tb);
      record("c", "test.probe.trio", ids.tc);
      await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, ${ids.tc}, false)`;
      const chainId = await enqueue("test.probe.trio");
      expect(await drain()).toBe(1);
      await vi.waitFor(async () => expect((await outboxRow(chainId))!.last_error).toBe("module_disabled"), WAIT);
      expect(await deadLetter(chainId)).toBeUndefined();
      expect(calls).toEqual(["a"]);
      expect(await drain()).toBe(0);

      await sql`update kernel.company_modules set enabled = true where company_id = ${companyId} and module_id = ${ids.tc}`;
      expect(await drain()).toBe(1);
      const dead = await parkedAs(chainId, ids.tb);
      expect([...dead.delivered_modules].sort()).toEqual([ids.ta, ids.tc].sort());
      expect(calls).toEqual(["a", "c"]);
    });
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

  it("a failing parked-event sweep is logged and does not stop the drain (Task 52.2, R52-3)", async () => {
    handlers["test.probe.created"] = async () => {};
    const chainId = await enqueue("test.probe.created");
    // A client whose sweep call raises; every other statement goes to the real client.
    const failing = new Proxy(sql, {
      apply: (target, thisArg, args: unknown[]) => {
        const strings = args[0] as readonly string[] | undefined;
        if (Array.isArray(strings) && strings.join("?").includes("parked_events_sweep")) return Promise.reject(new Error("sweep boom"));
        return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
      },
      get: (target, prop) => {
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await drainOutbox(failing, 100, { companyIds: [companyId] })).toBe(1);
      expect(logged).toHaveBeenCalledWith("outbox: parked-event sweep failed", expect.objectContaining({ message: "sweep boom" }));
      await vi.waitFor(isDispatched(chainId), WAIT);
    } finally {
      logged.mockRestore();
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
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${seed.tenantId}, ${`module:${ids.wild}`}, 'manual')`;
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
  it("a never-bought module's \"*\" consumer and its kernel.* consumer are skipped silently: events flow, nothing is dead-lettered (fix round 1, I2)", async () => {
    const ran: string[] = [];
    loadModules(registry, [defineModule({
      id: ids.wild2,
      version: "1",
      dependsOn: [],
      entities: [],
      processes: [],
      features: [],
      events: { emits: [], consumes: { "*": async () => void ran.push("*"), "kernel.module.enabled": async () => void ran.push("kernel") } },
      navigation: [],
    })]);
    handlers[`${ids.a}/test.probe.partial`] = async () => undefined;
    handlers[`${ids.b}/test.probe.partial`] = async () => undefined;
    handlers[`${ids.wild}/*`] = async () => undefined;
    expect(consumers.for("test.probe.partial").map((c) => c.moduleId)).toContain(ids.wild2);
    const normal = await enqueue("test.probe.partial");
    const platform = await enqueue("kernel.module.enabled", { moduleId: "x" });
    expect(await drain()).toBe(2);
    await vi.waitFor(isDispatched(normal), WAIT);
    await vi.waitFor(isDispatched(platform), WAIT);
    expect(await deadLetter(normal)).toBeUndefined();
    expect(await deadLetter(platform)).toBeUndefined();
    expect(ran).toEqual([]);
  });

  it("dead-lettering keeps who had handled the event; buying the module (an entitlement row) replays it on the next drain and only the unentitled consumer runs (fix round 1, I3 and I4)", async () => {
    const calls: string[] = [];
    handlers[`${ids.a}/test.probe.deliv`] = async () => void calls.push("a");
    handlers[`${ids.unbought}/test.probe.deliv`] = async () => void calls.push("unbought");
    const chainId = await enqueue("test.probe.deliv");
    expect(await drain()).toBe(1);
    await vi.waitFor(async () => expect(await deadLetter(chainId)).toBeDefined(), WAIT);
    const dead = (await deadLetter(chainId))!;
    expect(dead.last_error).toBe(`not_entitled:${ids.unbought}`);
    expect(dead.delivered_modules).toContain(ids.a);
    expect(calls).toEqual(["a"]);

    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${seed.tenantId}, ${`module:${ids.unbought}`}, 'manual')`;
    try {
      expect(await drain()).toBe(1); // the sweep put it back, then it was claimed
      await vi.waitFor(isDispatched(chainId), WAIT);
      expect(calls).toEqual(["a", "unbought"]);
      expect(await deadLetter(chainId)).toBeUndefined();
    } finally {
      await sql`delete from kernel.tenant_entitlements where tenant_id = ${seed.tenantId} and key = ${`module:${ids.unbought}`}`;
    }
  });

  // Owner item 119 (e) (2026-11-09, F-1.5): the parked module has its own dead-letter column, so a later consumer's failure that writes its
  // own message into last_error does not hide the event from the sweep.
  it("a row parked for a never-bought module and then failed by a later consumer keeps parked_module; buying the module replays it (item 119 e)", async () => {
    const calls: string[] = [];
    let failing = true;
    expect(consumers.for("test.probe.ba").map((c) => c.moduleId).slice(0, 2)).toEqual([ids.tb, ids.tc]);
    handlers[`${ids.tb}/test.probe.ba`] = async () => void calls.push("tb");
    handlers[`${ids.tc}/test.probe.ba`] = async () => {
      if (failing) throw new FatalError("tc refused it");
      calls.push("tc");
    };
    const chainId = await enqueue("test.probe.ba");
    expect(await drain()).toBe(1);
    await vi.waitFor(async () => expect(await deadLetter(chainId)).toBeDefined(), WAIT);
    const dead = (await deadLetter(chainId))!;
    expect(dead.last_error).toMatch(/tc refused it/);
    expect(dead.parked_module).toBe(ids.tb);
    expect(calls).toEqual([]);

    failing = false;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${seed.tenantId}, ${`module:${ids.tb}`}, 'manual')`;
    try {
      expect(await drain()).toBe(1); // the sweep found it by parked_module and put it back
      await vi.waitFor(isDispatched(chainId), WAIT);
      expect(calls).toEqual(["tb", "tc"]);
      expect(await deadLetter(chainId)).toBeUndefined();
    } finally {
      await sql`delete from kernel.tenant_entitlements where tenant_id = ${seed.tenantId} and key = ${`module:${ids.tb}`}`;
    }
  });

  // Owner item 111 (2026-11-09, F-1.2; item 9 (b)): the "*" consumer of a never-bought module that provides posting dead-letters the event
  // `not_entitled:<module>` (visible on Admin › Módulos, replayed on purchase); every other never-bought "*" consumer stays silent (item 52).
  // Registered last: a never-bought wildcard that parks would dead-letter the events of every test after it.
  it("a never-bought posting module's \"*\" consumer parks an invoice event not_entitled:<module>; buying it replays the event and the entry posts (item 111)", async () => {
    const posted: string[] = [];
    const ledger = `dsp_ledger_${run}`;
    loadModules(registry, [defineModule({
      id: ledger,
      version: "1",
      dependsOn: [],
      entities: [],
      processes: [],
      features: [],
      events: { emits: [], consumes: { "*": async (ctx) => void posted.push(`${ctx.event.name}:${ctx.chainId}`) } },
      navigation: [],
      postingProvider: {} as PostingProvider,
    })]);
    handlers[`${ids.wild}/*`] = async () => undefined;
    const invoice = await enqueue("invoicing.invoice.issued", { invoiceId: randomUUID() });
    const platform = await enqueue("kernel.module.enabled", { moduleId: "x" });
    expect(await drain()).toBe(2);
    await vi.waitFor(async () => expect(await deadLetter(invoice)).toBeDefined(), WAIT);
    const dead = (await deadLetter(invoice))!;
    expect(dead.last_error).toBe(`not_entitled:${ledger}`);
    expect(dead.parked_module).toBe(ledger);
    expect(dead.delivered_modules).toContain(ids.wild);
    // The platform's own events stay silent, and so does the never-bought "*" consumer without a posting provider (wild2).
    await vi.waitFor(isDispatched(platform), WAIT);
    expect(await deadLetter(platform)).toBeUndefined();
    expect(posted).toEqual([]);

    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${seed.tenantId}, ${`module:${ledger}`}, 'manual')`;
    try {
      expect(await drain()).toBe(1); // the sweep put it back, then it was claimed
      await vi.waitFor(isDispatched(invoice), WAIT);
      expect(posted).toEqual([`invoicing.invoice.issued:${invoice}`]);
      expect(await deadLetter(invoice)).toBeUndefined();
    } finally {
      await sql`delete from kernel.tenant_entitlements where tenant_id = ${seed.tenantId} and key = ${`module:${ledger}`}`;
    }
  });
});
