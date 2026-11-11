import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { withClaims } from "../../db/client";
import { testDb, seedTenant } from "../../db/test-db";
import { Registry } from "../../registry";
import type { ProcessDef } from "../../registry/types";
import { runnableProcesses } from "../permissions";

// What the shell may offer a caller (menus, ⌘K create commands): the processes one of their roles may run in
// the active company, plus the self-service ones. The same rule runProcess applies, asked in one query.

// Built directly: `defineProcess` reserves `permission: "none"` for kernel user prefs (define.test.ts).
const proc = (id: string, permission?: "none"): ProcessDef => ({
  id,
  module: "test",
  kind: "consult",
  ...(permission ? { permission } : {}),
  description: "prueba",
  input: z.object({}),
  output: z.null(),
  handler: async () => null,
});

describe("runnableProcesses", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  const registry = new Registry();

  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, { companies: 2, users: [{ name: "cashier", companies: [0], role: "member" }] });
    for (const p of [proc("test.a.list"), proc("test.b.list"), proc("test.self.get", "none")]) registry.registerProcess(p);
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
              values (${seed.companies[0]!.id}, ${seed.companies[0]!.memberRoleId}, 'test.a.list')`;
  });
  afterAll(async () => {
    await sql`delete from kernel.process_permissions where company_id = any(${seed.companies.map((c) => c.id)}::uuid[])`;
    await seed.cleanup();
    await sql.end();
  });

  it("returns the granted and the permission-free processes, nothing else", async () => {
    const claims = seed.claimsFor(seed.users.cashier!, seed.companies[0]!.id);
    const ids = ["test.a.list", "test.b.list", "test.self.get"];
    expect([...(await runnableProcesses(sql, registry, claims, ids))].sort()).toEqual(["test.a.list", "test.self.get"]);
  });

  it("kernel.runnable_processes answers, id by id, what can_run_process and the membership check answer", async () => {
    const ids = ["test.a.list", "test.b.list", "test.self.get", "test.nope.list"];
    for (const claims of [seed.claimsFor(seed.users.cashier!, seed.companies[0]!.id), seed.claimsFor(seed.users.both, seed.companies[0]!.id), { ...seed.claimsFor(seed.users.both, seed.companies[1]!.id), role_ids: [seed.companies[1]!.memberRoleId] }]) {
      const [oneByOne, together] = await withClaims(sql, claims, async (tx) => [
        await tx<{ id: string; allowed: boolean; member: boolean }[]>`
          select p.id, kernel.can_run_process(p.id) as allowed,
                 coalesce(kernel.current_company_id() = any (kernel.current_company_ids()), false) and not kernel.membership_inactive() as member
          from unnest(${ids}::text[]) as p(id) order by p.id`,
        await tx<{ id: string; allowed: boolean; member: boolean }[]>`select id, allowed, member from kernel.runnable_processes(${ids}::text[]) order by id`,
      ]);
      expect(together).toEqual(oneByOne);
    }
  });

  it("callers asking in the same tick share one query and each gets the answer for its own ids and its own claims", async () => {
    const cashier = seed.claimsFor(seed.users.cashier!, seed.companies[0]!.id);
    const other = { ...seed.claimsFor(seed.users.both, seed.companies[1]!.id), role_ids: [seed.companies[1]!.memberRoleId] };
    const statements: string[] = [];
    const watched = new Proxy(sql, { apply: (target, self, args) => { statements.push(String(args[0]?.[0] ?? "")); return Reflect.apply(target, self, args); }, get: (target, prop, receiver) => (prop === "begin" ? (...a: unknown[]) => { statements.push("begin"); return (target.begin as (...x: unknown[]) => unknown)(...a); } : Reflect.get(target, prop, receiver)) }) as typeof sql;
    const [a, b, c, d] = await Promise.all([
      runnableProcesses(watched, registry, cashier, ["test.a.list"]),
      runnableProcesses(watched, registry, cashier, ["test.b.list", "test.self.get"]),
      runnableProcesses(watched, registry, cashier, ["test.a.list", "test.b.list"]),
      runnableProcesses(watched, registry, other, ["test.a.list", "test.self.get"]),
    ]);
    expect([...a]).toEqual(["test.a.list"]);
    expect([...b]).toEqual(["test.self.get"]);
    expect([...c]).toEqual(["test.a.list"]);
    expect([...d]).toEqual(["test.self.get"]);
    // One transaction per distinct caller (two), not one per call (four).
    expect(statements.filter((x) => x === "begin")).toHaveLength(2);
  });

  it("a grant in another company does not count", async () => {
    // The member role of company 1 (company 0's member role holds the grant); not the admin, who runs everything (0021).
    const claims = { ...seed.claimsFor(seed.users.both, seed.companies[1]!.id), role_ids: [seed.companies[1]!.memberRoleId] };
    expect([...(await runnableProcesses(sql, registry, claims, ["test.a.list"]))]).toEqual([]);
  });

  it("unknown ids are ignored", async () => {
    const claims = seed.claimsFor(seed.users.cashier!, seed.companies[0]!.id);
    expect([...(await runnableProcesses(sql, registry, claims, ["test.nope.list"]))]).toEqual([]);
  });
});
