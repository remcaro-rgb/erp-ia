import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testDb, seedTenant } from "../../db/test-db";
import { withClaims } from "../../db/client";
import { Registry } from "../../registry";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { runProcess } from "../../process/run";
import type { Caller } from "../../process/context";

// Per-user preferences (design §19a: theme, open tabs, home layout) in kernel.user_prefs, migration
// 0012_kernel_user_prefs. Any member sets their own through kernel.user_prefs.set (permission-free,
// audited); nobody reads or writes anyone else's, and a company's prefs stay in that company.

describe("user prefs", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let cashier: Caller;
  let adminA: Caller;
  let adminB: Caller;
  const run = (caller: Caller, id: string, input: unknown) => runProcess({ sql, registry }, caller, id, input);
  const companyIds = () => seed.companies.map((c) => c.id);

  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, { companies: 2, users: [{ name: "cashier", companies: [0], role: "member" }] });
    registry = new Registry();
    loadModules(registry, [kernelModule]);
    cashier = { claims: seed.claimsFor(seed.users.cashier!, seed.companies[0]!.id), origin: "ui" };
    adminA = { claims: seed.claimsFor(seed.users.both, seed.companies[0]!.id), origin: "ui" };
    adminB = { claims: seed.claimsFor(seed.users.both, seed.companies[1]!.id), origin: "ui" };
  });
  afterAll(async () => {
    await sql`delete from kernel.user_prefs where company_id = any(${companyIds()}::uuid[])`;
    await seed.cleanup();
    await sql.end();
  });

  it("a member with no permission rows sets and reads back their theme; the set is audited", async () => {
    const chainId = crypto.randomUUID();
    await run({ ...cashier, chainId }, "kernel.user_prefs.set", { key: "theme", value: "dark" });
    await expect(run(cashier, "kernel.user_prefs.get", { key: "theme" })).resolves.toEqual({ key: "theme", value: "dark" });
    const audits = await sql`select process_id, action from kernel.audit_log where chain_id = ${chainId}`;
    expect(audits.map((a) => a.process_id)).toContain("kernel.user_prefs.set");
  });

  it("setting a key again replaces the value (one row per user, company and key)", async () => {
    const tabs = [{ id: "home", title: "Inicio", href: "/", kind: "home", pinned: true }];
    await run(cashier, "kernel.user_prefs.set", { key: "tabs", value: { tabs, activeId: "home" } });
    await run(cashier, "kernel.user_prefs.set", { key: "tabs", value: { tabs: [], activeId: "home" } });
    await expect(run(cashier, "kernel.user_prefs.get", { key: "tabs" })).resolves.toEqual({ key: "tabs", value: { tabs: [], activeId: "home" } });
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from kernel.user_prefs where user_id = ${seed.users.cashier!} and key = 'tabs'`;
    expect(row!.n).toBe(1);
  });

  it("an unknown key reads as null", async () => {
    await expect(run(cashier, "kernel.user_prefs.get", { key: "home_layout" })).resolves.toEqual({ key: "home_layout", value: null });
  });

  it("refuses malformed keys and oversized values", async () => {
    await expect(run(cashier, "kernel.user_prefs.set", { key: "Not A Key", value: 1 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(cashier, "kernel.user_prefs.set", { key: "theme", value: "x".repeat(70_000) })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("prefs are per company: the same user sees their company-A theme only in company A", async () => {
    await run(adminA, "kernel.user_prefs.set", { key: "theme", value: "light" });
    await expect(run(adminA, "kernel.user_prefs.get", { key: "theme" })).resolves.toEqual({ key: "theme", value: "light" });
    await expect(run(adminB, "kernel.user_prefs.get", { key: "theme" })).resolves.toEqual({ key: "theme", value: null });
  });

  it("RLS: a user never reads another user's prefs, even as the company admin", async () => {
    const seen = await withClaims(sql, adminA.claims, (tx) => tx<{ user_id: string }[]>`select user_id from kernel.user_prefs`);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.user_id === seed.users.both)).toBe(true);
  });

  it("RLS: no write outside the process pipeline, and none for another user", async () => {
    const direct = withClaims(sql, cashier.claims, (tx) =>
      tx`insert into kernel.user_prefs(user_id, company_id, key, value) values (${seed.users.cashier!}, ${seed.companies[0]!.id}, 'x', '1'::jsonb)`,
    );
    await expect(direct).rejects.toThrow(/row-level security/);
    const forged = withClaims(sql, cashier.claims, async (tx) => {
      await tx`select set_config('erp.audit_process_id', 'kernel.user_prefs.set', true)`;
      await tx`insert into kernel.user_prefs(user_id, company_id, key, value) values (${seed.users.both}, ${seed.companies[0]!.id}, 'x', '1'::jsonb)`;
    });
    await expect(forged).rejects.toThrow(/row-level security/);
    const update = await withClaims(sql, cashier.claims, (tx) => tx`update kernel.user_prefs set value = '"hacked"'::jsonb where user_id = ${seed.users.both} returning 1`);
    expect(update).toHaveLength(0);
  });
});
