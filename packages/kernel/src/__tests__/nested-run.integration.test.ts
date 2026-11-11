import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import type { JwtClaims, Tx } from "../db/client";
import { testDb, seedTenant, ensureRoleProbe } from "../db/test-db";
import { registry } from "../registry";
import { defineProcess } from "../process/define";
import { runProcess } from "../process/run";
import type { Caller } from "../process/context";

// ctx.runProcess (plan 2B Task 11 review): a process runs another registered process in its own transaction, as the same caller.

const insertProbe = async (tx: Tx, companyId: string, secret: string) => {
  const [r] = await tx`insert into kernel.role_probe(company_id, secret) values (${companyId}, ${secret}) returning id`;
  return r!.id as string;
};

const inner = defineProcess({
  id: "test.nested.inner",
  module: "test",
  kind: "create",
  description: "proceso anidado",
  input: z.object({ name: z.string().min(1), fail: z.boolean().optional() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const id = await insertProbe(ctx.tx, ctx.companyId, input.name);
    await ctx.emit("test.nested.inner_done", { id });
    if (input.fail) throw new Error("boom");
    return { id };
  },
});
const sensitiveInner = defineProcess({
  id: "test.nested.sensitive",
  module: "test",
  kind: "create",
  description: "proceso anidado sensible",
  sensitivity: "step-up",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});
// nestedOnlyFrom (plan 2B Task 18): a process that runs only nested in the named parents, never on its own (the annulment note).
const onlyNested = defineProcess({
  id: "test.nested.only",
  module: "test",
  kind: "create",
  description: "proceso que solo corre anidado",
  nestedOnlyFrom: ["test.nested.outer"],
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => ({ id: await insertProbe(ctx.tx, ctx.companyId, input.name) }),
});
const otherOuter = defineProcess({
  id: "test.nested.other_outer",
  module: "test",
  kind: "create",
  description: "otro proceso que llama a otro",
  input: z.object({ target: z.string(), input: z.unknown() }),
  output: z.object({ inner: z.unknown() }),
  handler: async (ctx, { target, input }) => ({ inner: await ctx.runProcess!(target, input) }),
});
const outer = defineProcess({
  id: "test.nested.outer",
  module: "test",
  kind: "create",
  description: "proceso que llama a otro",
  input: z.object({ target: z.string(), input: z.unknown(), name: z.string() }),
  output: z.object({ first: z.string(), inner: z.unknown(), last: z.string() }),
  handler: async (ctx, { target, input, name }) => {
    const first = await insertProbe(ctx.tx, ctx.companyId, `${name}-before`);
    const result = await ctx.runProcess!(target, input);
    const last = await insertProbe(ctx.tx, ctx.companyId, `${name}-after`);
    return { first, inner: result, last };
  },
});

// Final review M-3: an outer process that catches a nested failure and goes on (no SQL error: the transaction is still usable).
const catching = defineProcess({
  id: "test.nested.catching",
  module: "test",
  kind: "create",
  description: "proceso que atrapa el error del anidado",
  input: z.object({ name: z.string() }),
  output: z.object({ last: z.string(), caught: z.string() }),
  handler: async (ctx, { name }) => {
    const caught = await ctx.runProcess!("test.nested.inner", { name: `${name}-in`, fail: true }).then(() => "none", (e: { code?: string }) => e.code ?? "error");
    const last = await insertProbe(ctx.tx, ctx.companyId, `${name}-after`);
    return { last, caught };
  },
});

describe("ctx.runProcess (nested run)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let deps: { sql: ReturnType<typeof testDb>; registry: typeof registry };
  let companyId: string;
  let admin: Caller;
  let cashier: Caller;

  beforeAll(async () => {
    sql = testDb();
    await ensureRoleProbe(sql);
    await sql`grant insert on kernel.role_probe to authenticated`;
    await sql`select kernel.enable_row_audit('kernel', 'role_probe')`;
    seed = await seedTenant(sql, { companies: 1, users: [{ name: "cashier", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    deps = { sql, registry };
    for (const p of [inner, sensitiveInner, outer, onlyNested, otherOuter, catching]) registry.registerProcess(p);
    admin = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };
    cashier = { claims: seed.claimsFor(seed.users.cashier!, companyId) as JwtClaims, origin: "ui" };
    // The cashier may run the outer process only.
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.memberRoleId}, 'test.nested.outer') on conflict do nothing`;
    for (const id of ["test.nested.inner", "test.nested.sensitive", "test.nested.outer", "test.nested.only", "test.nested.other_outer", "test.nested.catching"]) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.adminRoleId}, ${id}) on conflict do nothing`;
    }
  });
  afterAll(async () => {
    // Other suites count the audit rows of this table's writes: leave it as it was.
    await sql`drop trigger if exists audit_row_change on kernel.role_probe`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await sql`delete from kernel.role_probe where company_id = ${companyId}`;
    await seed.cleanup();
    await sql.end();
  });

  const probes = async (prefix: string) => sql<{ secret: string }[]>`select secret from kernel.role_probe where company_id = ${companyId} and secret like ${prefix + "-%"} order by secret`;

  it("runs the inner process in the same transaction: its writes are attributed to it, the rest to the outer, one chain, one actor", async () => {
    const out = await runProcess(deps, admin, "test.nested.outer", { target: "test.nested.inner", input: { name: "ok-in" }, name: "ok" }) as { first: string; last: string; inner: { id: string } };
    expect((await probes("ok")).map((r) => r.secret)).toEqual(["ok-after", "ok-before", "ok-in"]);
    const rows = await sql<{ row_id: string; process_id: string; chain_id: string; actor_user_id: string; origin: string; action: string }[]>`
      select row_id, process_id, chain_id, actor_user_id, origin, action from kernel.audit_log where row_id = any(${[out.first, out.inner.id, out.last]}::uuid[]) and entity = 'kernel.role_probe'`;
    const byRow = Object.fromEntries(rows.map((r) => [r.row_id, r]));
    expect(byRow[out.first]!.process_id).toBe("test.nested.outer");
    expect(byRow[out.inner.id]!.process_id).toBe("test.nested.inner");
    expect(byRow[out.last]!.process_id).toBe("test.nested.outer");
    expect(new Set(rows.map((r) => r.chain_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.actor_user_id))).toEqual(new Set([admin.claims.sub]));
    expect(new Set(rows.map((r) => r.origin))).toEqual(new Set(["ui"]));
    // The nested process has an audit entry of its own, on the same chain; its event too.
    const [entry] = await sql`select chain_id, row_id from kernel.audit_log where process_id = 'test.nested.inner' and entity = 'test.nested' and row_id = ${out.inner.id}`;
    expect(entry!.chain_id).toBe(rows[0]!.chain_id);
    const [event] = await sql`select chain_id from kernel.outbox where event = 'test.nested.inner_done' and payload->>'id' = ${out.inner.id}`;
    expect(event!.chain_id).toBe(rows[0]!.chain_id);
  });

  it("checks the permission of the nested process for the caller and rolls the whole run back", async () => {
    const error = await runProcess(deps, cashier, "test.nested.outer", { target: "test.nested.inner", input: { name: "deny-in" }, name: "deny" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "forbidden" });
    expect(await probes("deny")).toEqual([]);
  });

  it("refuses a nested process that needs a step-up, even when the outer run is a normal one", async () => {
    await expect(runProcess(deps, admin, "test.nested.outer", { target: "test.nested.sensitive", input: {}, name: "step" })).rejects.toMatchObject({ code: "step_up_required" });
    expect(await probes("step")).toEqual([]);
  });

  it("propagates the failure and invalid input of the nested process, undoing the outer writes and the event", async () => {
    await expect(runProcess(deps, admin, "test.nested.outer", { target: "test.nested.inner", input: { name: "fail-in", fail: true }, name: "fail" })).rejects.toMatchObject({ code: "handler_failed" });
    await expect(runProcess(deps, admin, "test.nested.outer", { target: "test.nested.inner", input: { name: "" }, name: "bad" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await probes("fail")).toEqual([]);
    expect(await probes("bad")).toEqual([]);
    expect(await probes("fail-in")).toEqual([]);
    expect((await sql`select 1 from kernel.outbox where company_id = ${companyId} and event = 'test.nested.inner_done'`).length).toBe(1);
  });

  it("an unknown nested process is not_found", async () => {
    await expect(runProcess(deps, admin, "test.nested.outer", { target: "test.nested.nope", input: {}, name: "nf" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("a nestedOnlyFrom process is forbidden on its own and from another parent, and runs nested in its named parent", async () => {
    await expect(runProcess(deps, admin, "test.nested.only", { name: "solo-x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(runProcess(deps, admin, "test.nested.other_outer", { target: "test.nested.only", input: { name: "other-x" } })).rejects.toMatchObject({ code: "forbidden" });
    const out = await runProcess(deps, admin, "test.nested.outer", { target: "test.nested.only", input: { name: "only-in" }, name: "only" }) as { inner: { id: string } };
    expect(out.inner.id).toBeTruthy();
    expect(await probes("solo")).toEqual([]);
    expect(await probes("other")).toEqual([]);
    expect((await probes("only")).map((r) => r.secret)).toEqual(["only-after", "only-before", "only-in"]);
    // Its parent's role gate covers it: the cashier may run the outer process only, and the nested one runs inside it.
    await runProcess(deps, cashier, "test.nested.outer", { target: "test.nested.only", input: { name: "cash-in" }, name: "cash" });
    expect((await probes("cash")).map((r) => r.secret)).toEqual(["cash-after", "cash-before", "cash-in"]);
  });

  it("an outer process that catches a nested failure writes the rest attributed to itself again (final review M-3)", async () => {
    const out = await runProcess(deps, admin, "test.nested.catching", { name: "catch" }) as { last: string; caught: string };
    expect(out.caught).toBe("handler_failed");
    const [row] = await sql<{ process_id: string }[]>`select process_id from kernel.audit_log where row_id = ${out.last} and entity = 'kernel.role_probe'`;
    expect(row!.process_id).toBe("test.nested.catching");
  });
});
