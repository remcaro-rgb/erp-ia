import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { testDb, seedTenant } from "../../db/test-db";
import { Registry } from "../../registry";
import { defineProcess } from "../define";
import { runProcess } from "../run";
import type { Caller } from "../context";
import type { ProcessDef } from "../../registry/types";

// Self-service processes (a user's own preferences) opt out of the role permission matrix with
// `permission: "none"`: any member of the company may run them, but they are still resolved, entitled,
// validated and audited like every other process (rule 1, rule 16).

let handlerRuns = 0;

// Built without `defineProcess`, which reserves the opt-out for kernel user prefs (define.test.ts): here the
// point is what `runProcess` does with it, on a module whose entitlement can be refused.
const selfService: ProcessDef = {
  id: "test.self.touch",
  module: "test",
  kind: "update",
  permission: "none",
  description: "proceso de autoservicio",
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  handler: async (_ctx, input: { n: number }) => {
    handlerRuns += 1;
    return { n: input.n + 1 };
  },
};

const guarded = defineProcess({
  id: "test.self.guarded",
  module: "test",
  kind: "update",
  description: "proceso con permiso por rol",
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  handler: async (_ctx, input) => ({ n: input.n }),
});

describe("runProcess permission opt-out", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let cashier: Caller;

  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, { companies: 1, users: [{ name: "cashier", companies: [0], role: "member" }] });
    registry = new Registry();
    registry.registerProcess(selfService);
    registry.registerProcess(guarded);
    cashier = { claims: seed.claimsFor(seed.users.cashier!, seed.companies[0]!.id), origin: "ui" };
  });
  afterAll(async () => {
    await seed.cleanup();
    await sql.end();
  });

  it("a member without any permission row runs a permission-free process, and the run is audited", async () => {
    const chainId = crypto.randomUUID();
    await expect(runProcess({ sql, registry }, { ...cashier, chainId }, "test.self.touch", { n: 1 })).resolves.toEqual({ n: 2 });
    const audits = await sql`select action, actor_user_id, origin from kernel.audit_log where chain_id = ${chainId}`;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "update", actor_user_id: seed.users.cashier, origin: "ui" });
  });

  it("the same member is still forbidden a process that keeps the permission check", async () => {
    await expect(runProcess({ sql, registry }, cashier, "test.self.guarded", { n: 1 })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("membership of the active company is still required", async () => {
    const outsider: Caller = { ...cashier, claims: { ...cashier.claims, company_ids: [] } };
    const before = handlerRuns;
    // Refused before the handler; the denial's own audit row is then refused by RLS (not a company of the caller).
    const error = await runProcess({ sql, registry }, outsider, "test.self.touch", { n: 1 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    expect(String((error as Error).message)).toMatch(/forbidden|row-level security|no role/);
    expect(handlerRuns).toBe(before);
  });

  it("the opt-out skips only the permission: entitlement and input are still checked", async () => {
    const entitled = async () => false;
    await expect(runProcess({ sql, registry, entitled }, cashier, "test.self.touch", { n: 1 })).rejects.toMatchObject({ code: "not_entitled" });
    await expect(runProcess({ sql, registry }, cashier, "test.self.touch", { n: "x" })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
