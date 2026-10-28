import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { testDb, seedTenant } from "../../db/test-db";
import { Registry } from "../../registry";
import { defineProcess } from "../define";
import { runnableProcesses } from "../permissions";

// What the shell may offer a caller (menus, ⌘K create commands): the processes one of their roles may run in
// the active company, plus the self-service ones. The same rule runProcess applies, asked in one query.

const proc = (id: string, permission?: "none") =>
  defineProcess({
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

  it("a grant in another company does not count", async () => {
    const claims = seed.claimsFor(seed.users.both, seed.companies[1]!.id);
    expect([...(await runnableProcesses(sql, registry, claims, ["test.a.list"]))]).toEqual([]);
  });

  it("unknown ids are ignored", async () => {
    const claims = seed.claimsFor(seed.users.cashier!, seed.companies[0]!.id);
    expect([...(await runnableProcesses(sql, registry, claims, ["test.nope.list"]))]).toEqual([]);
  });
});
