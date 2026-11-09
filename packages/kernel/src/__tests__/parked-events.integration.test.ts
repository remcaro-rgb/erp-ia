import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "../db/client";
import { seedTenant, testDb, type SeededTenant } from "../db/test-db";
import { enableModule } from "../entitlements/resolver";
import { defineModule } from "../module/define";
import { kernelModule } from "../module/kernel-module";
import { loadModules } from "../module/loader";
import { runProcess } from "../process/run";
import type { Caller } from "../process/context";
import { Registry } from "../registry";
import { syncRegistry } from "../admin/sync";

// Task 50.9 (owner 2026-11-06, decision item 9): events dead-lettered `not_entitled:<module>` for a module the company never bought are listed
// per module (kernel.admin.module.parked_events), dismissed without a step-up (kernel.admin.module.parked_events.dismiss, audited, rows kept),
// and replayed once into the outbox when the module is bought and enabled (the process, and enableModule on the service connection).

const sql = testDb();
const run = randomUUID().slice(0, 8);
const mods = { a: `pk_a_${run}`, b: `pk_b_${run}`, c: `pk_c_${run}` };
const stub = (id: string) => defineModule({ id, version: "1", dependsOn: [], entities: [], processes: [], features: [], events: { emits: [], consumes: {} }, navigation: [] });

describe("events parked for a module that was not bought", () => {
  let seed: SeededTenant;
  let registry: Registry;
  let companyId: string;
  let admin: Caller;
  let member: Caller;

  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${companyId}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const call = <T,>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const park = async (moduleId: string, n = 1) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [row] = await sql<{ id: string }[]>`
        insert into kernel.outbox_dead_letter (company_id, event, payload, chain_id, last_error)
        values (${companyId}, 'test.parked.event', ${sql.json({ i })}, ${randomUUID()}, ${`not_entitled:${moduleId}`}) returning id`;
      ids.push(row!.id);
    }
    return ids;
  };

  beforeAll(async () => {
    registry = new Registry();
    loadModules(registry, [kernelModule, stub(mods.a), stub(mods.b), stub(mods.c)]);
    seed = await seedTenant(sql, { companies: 1, entitlements: [], users: [{ name: "member", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    member = { claims: seed.claimsFor(seed.users.member!, companyId), origin: "ui" };
    await syncRegistry(sql, registry);
    await sql`select kernel.seed_company_defaults(${companyId})`;
  });
  afterAll(async () => {
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await sql`delete from kernel.outbox_dead_letter where company_id = ${companyId}`;
    await seed.cleanup();
    await sql.end();
  });

  it("the consult counts the open rows per module; the dismissal needs no step-up, keeps the rows and is audited; a member may not", async () => {
    await park(mods.a, 2);
    await park(mods.b, 1);
    const listed = await call<{ modules: { moduleId: string; count: number }[] }>(admin, "kernel.admin.module.parked_events", {});
    expect(listed.modules).toEqual([{ moduleId: mods.a, count: 2 }, { moduleId: mods.b, count: 1 }].sort((x, y) => x.moduleId.localeCompare(y.moduleId)));

    await expect(call(member, "kernel.admin.module.parked_events.dismiss", { moduleId: mods.a })).rejects.toMatchObject({ code: "forbidden" });
    // No step-up token on the admin caller.
    expect(await call(admin, "kernel.admin.module.parked_events.dismiss", { moduleId: mods.a })).toEqual({ moduleId: mods.a, dismissed: 2 });
    const after = await call<{ modules: { moduleId: string; count: number }[] }>(admin, "kernel.admin.module.parked_events", {});
    expect(after.modules).toEqual([{ moduleId: mods.b, count: 1 }]);
    const kept = await sql`select dismissed_at from kernel.outbox_dead_letter where company_id = ${companyId} and last_error = ${`not_entitled:${mods.a}`}`;
    expect(kept).toHaveLength(2);
    expect(kept.every((r) => r.dismissed_at !== null)).toBe(true);
    const audit = await sql`select 1 from kernel.audit_log where company_id = ${companyId} and process_id = 'kernel.admin.module.parked_events.dismiss'`;
    expect(audit.length).toBeGreaterThan(0);
    // Dismissing again finds nothing; a dismissed row is never replayed.
    expect(await call(admin, "kernel.admin.module.parked_events.dismiss", { moduleId: mods.a })).toEqual({ moduleId: mods.a, dismissed: 0 });
  });

  it("a user session reaches the SQL functions only inside a module administration process", async () => {
    await expect(withClaims(sql, admin.claims, (tx) => tx`select kernel.parked_events_dismiss(${companyId}, ${mods.b})`)).rejects.toThrow(/module administration process/);
    await expect(withClaims(sql, admin.claims, (tx) => tx`select kernel.parked_events_replay(${companyId}, ${mods.b})`)).rejects.toThrow(/module administration process/);
  });

  it("buying and enabling the module replays its parked events once into the outbox (process)", async () => {
    const [dismissed] = await sql<{ id: string }[]>`select id from kernel.outbox_dead_letter where company_id = ${companyId} and last_error = ${`not_entitled:${mods.a}`} limit 1`;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${seed.tenantId}, ${`module:${mods.b}`}, 'manual')`;
    const [parked] = await sql<{ id: string }[]>`select id from kernel.outbox_dead_letter where company_id = ${companyId} and last_error = ${`not_entitled:${mods.b}`}`;
    await call(await stepUp(admin), "kernel.admin.module.enable", { moduleId: mods.b });
    expect(await sql`select 1 from kernel.outbox_dead_letter where id = ${parked!.id}`).toHaveLength(0);
    const [back] = await sql<{ id: string; dispatched_at: Date | null; attempts: number }[]>`select id, dispatched_at, attempts from kernel.outbox where id = ${parked!.id}`;
    expect(back).toMatchObject({ id: parked!.id, dispatched_at: null, attempts: 0 });
    // The dismissed row of the other module stays on the dead letter table.
    expect(await sql`select 1 from kernel.outbox_dead_letter where id = ${dismissed!.id}`).toHaveLength(1);
    expect(await sql`select 1 from kernel.outbox where id = ${dismissed!.id}`).toHaveLength(0);
  });

  it("enableModule (the service connection) replays too, and only the module's own rows", async () => {
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${seed.tenantId}, ${`module:${mods.c}`}, 'manual')`;
    const [own] = await park(mods.c);
    const [other] = await park(mods.a);
    await enableModule(sql, companyId, mods.c, registry);
    expect(await sql`select 1 from kernel.outbox where id = ${own!}`).toHaveLength(1);
    expect(await sql`select 1 from kernel.outbox_dead_letter where id = ${other!}`).toHaveLength(1);
  });

  it("a row parked after the other consumers ran (Task 52.1): Descartar keeps delivered_modules; a replay restores every one of them", async () => {
    // As the dispatcher parks it now: consumers a and c ran, the unbought module (here `unb`) is the one in last_error.
    const unb = `pk_unb_${run}`;
    const parkWith = async () => {
      const [row] = await sql<{ id: string }[]>`
        insert into kernel.outbox_dead_letter (company_id, event, payload, chain_id, last_error, delivered_modules)
        values (${companyId}, 'test.parked.trio', '{}', ${randomUUID()}, ${`not_entitled:${unb}`}, ${[mods.a, mods.c]}) returning id`;
      return row!.id;
    };
    const dismissedId = await parkWith();
    expect((await sql`select kernel.parked_events_dismiss(${companyId}, ${unb}) as n`)[0]!.n).toBe(1);
    const [dismissed] = await sql`select dismissed_at, delivered_modules from kernel.outbox_dead_letter where id = ${dismissedId}`;
    expect(dismissed!.dismissed_at).not.toBeNull();
    expect([...dismissed!.delivered_modules].sort()).toEqual([mods.a, mods.c].sort());

    const replayedId = await parkWith();
    expect((await sql`select kernel.parked_events_replay(${companyId}, ${unb}) as n`)[0]!.n).toBe(1);
    const restored = await sql`select module_id from kernel.outbox_deliveries where outbox_id = ${replayedId} order by module_id`;
    expect(restored.map((r) => r.module_id)).toEqual([mods.a, mods.c].sort());
    // The dismissed row is not replayed.
    expect(await sql`select 1 from kernel.outbox where id = ${dismissedId}`).toHaveLength(0);
  });
});
