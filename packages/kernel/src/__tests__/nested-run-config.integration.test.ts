import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { withClaims, type JwtClaims, type Tx } from "../db/client";
import { ensureRoleProbe, seedTenant, testDb } from "../db/test-db";
import { Registry } from "../registry";
import type { ModuleDef } from "../registry/types";
import { loadModules } from "../module/loader";
import { kernelModule } from "../module/kernel-module";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { runProcess } from "../process/run";
import type { Caller, ProcessContext } from "../process/context";

// Plan 2B Task 32 (owner decisions items 1 and 2, migration 0126): configurable nested runs. Per pair (parent → nested) the admin sets
// whether the parent's fresh TOTP covers a step-up nested process and whether a failure rolls everything back (default) or continues and
// queues; depth is a company parameter (default 4, hard maximum 8). With no configuration the behaviour is the fixed one of Task 11.

const insertProbe = async (tx: Tx, companyId: string, secret: string, id?: string) => {
  const [r] = id
    ? await tx`insert into kernel.role_probe(id, company_id, secret) values (${id}, ${companyId}, ${secret}) returning id`
    : await tx`insert into kernel.role_probe(company_id, secret) values (${companyId}, ${secret}) returning id`;
  return r!.id as string;
};

/** Whether the flaky process fails (a retry test opens it). */
const flaky = { fails: true };

const outerInput = z.object({ target: z.string(), input: z.unknown(), name: z.string() });
const outerBody = async (ctx: ProcessContext, { target, input, name }: z.infer<typeof outerInput>) => {
  const first = await insertProbe(ctx.tx, ctx.companyId, `${name}-before`);
  const inner = await ctx.runProcess!(target, input);
  const last = await insertProbe(ctx.tx, ctx.companyId, `${name}-after`);
  return { first, inner: inner ?? null, last };
};
const outer = defineProcess({ id: "test.nestcfg.outer", module: "test", kind: "create", description: "padre", input: outerInput, output: z.unknown(), handler: outerBody });
const outerSu = defineProcess({ id: "test.nestcfg.outer_su", module: "test", kind: "create", sensitivity: "step-up", description: "padre sensible", input: outerInput, output: z.unknown(), handler: outerBody });

const inner = defineProcess({
  id: "test.nestcfg.inner",
  module: "test",
  kind: "create",
  description: "anidado",
  input: z.object({ name: z.string().min(1), fail: z.enum(["invalid", "boom", "sql", "forbidden", "privilege"]).optional() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const id = await insertProbe(ctx.tx, ctx.companyId, input.name);
    await ctx.emit("test.nestcfg.inner_done", { id });
    ctx.afterCommit?.(async (asCaller) => {
      await asCaller((tx) => insertProbe(tx, ctx.companyId, `${input.name}-ac`));
    });
    if (input.fail === "invalid") throw new ProcessError("invalid_input", "fails on purpose", { details: ["La prueba falló a propósito"] });
    if (input.fail === "boom") throw new Error("boom: secret stack detail");
    if (input.fail === "sql") await insertProbe(ctx.tx, ctx.companyId, `${input.name}-dup`, id);
    if (input.fail === "forbidden") throw new ProcessError("forbidden", "denied on purpose");
    // A definer writer refusing this run (insufficient_privilege, 42501): a SQL denial.
    if (input.fail === "privilege") await ctx.tx`select kernel.nested_run_depth_set(5)`;
    return { id };
  },
});
const sensitive = defineProcess({
  id: "test.nestcfg.sensitive",
  module: "test",
  kind: "create",
  sensitivity: "step-up",
  description: "anidado sensible",
  input: z.object({ name: z.string() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { name }) => ({ id: await insertProbe(ctx.tx, ctx.companyId, name) }),
});
const only = defineProcess({
  id: "test.nestcfg.only",
  module: "test",
  kind: "create",
  description: "solo anidado",
  nestedOnlyFrom: ["test.nestcfg.outer_su"],
  input: z.object({ name: z.string() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { name }) => ({ id: await insertProbe(ctx.tx, ctx.companyId, name) }),
});
// In a module of its own that posts (fix round 1, I1: every process of a module with posting rules counts as ledger or stock).
const posting = defineProcess({
  id: "testledger.posting",
  module: "testledger",
  kind: "create",
  description: "contabiliza",
  emits: ["test.nestcfg.posted"],
  input: z.object({ name: z.string(), fail: z.boolean().optional() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { name, fail }) => {
    const id = await insertProbe(ctx.tx, ctx.companyId, name);
    await ctx.emit("test.nestcfg.posted", { id });
    if (fail) throw new ProcessError("invalid_input", "fails on purpose", { details: ["No contabiliza"] });
    return { id };
  },
});
// No declared emits: what it sets off is known only at run time (its own nested run).
const middle = defineProcess({
  id: "test.nestcfg.middle",
  module: "test",
  kind: "create",
  description: "intermedio",
  input: z.object({ name: z.string(), target: z.string(), input: z.unknown() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { name, target, input }) => {
    await insertProbe(ctx.tx, ctx.companyId, name);
    await ctx.runProcess!(target, input);
    throw new ProcessError("invalid_input", "fails after its nested run", { details: ["Falla después"] });
  },
});
const chain = defineProcess({
  id: "test.nestcfg.chain",
  module: "test",
  kind: "create",
  description: "cadena",
  input: z.object({ level: z.number().int().min(0), name: z.string() }),
  output: z.object({ ok: z.boolean() }),
  handler: async (ctx, { level, name }) => {
    await insertProbe(ctx.tx, ctx.companyId, `${name}-${level}`);
    if (level > 0) await ctx.runProcess!("test.nestcfg.chain", { level: level - 1, name });
    return { ok: true };
  },
});
const flakyProcess = defineProcess({
  id: "test.nestcfg.flaky",
  module: "test",
  kind: "create",
  description: "a veces falla",
  input: z.object({ name: z.string() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { name }) => {
    const id = await insertProbe(ctx.tx, ctx.companyId, name);
    if (flaky.fails) throw new ProcessError("invalid_input", "flaky", { details: ["Falla por ahora"] });
    return { id };
  },
});
// Fix round 1: a step-up nested process that fails until opened, and a nestedOnlyFrom one of the plain parent (retry tests, I2 and M8).
const flakySu = defineProcess({
  id: "test.nestcfg.flaky_su",
  module: "test",
  kind: "create",
  sensitivity: "step-up",
  description: "sensible que a veces falla",
  input: z.object({ name: z.string() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { name }) => {
    const id = await insertProbe(ctx.tx, ctx.companyId, name);
    if (flaky.fails) throw new ProcessError("invalid_input", "flaky", { details: ["Falla por ahora"] });
    return { id };
  },
});
const flakyOnly = defineProcess({
  id: "test.nestcfg.flaky_only",
  module: "test",
  kind: "create",
  description: "solo anidado en el padre, a veces falla",
  nestedOnlyFrom: ["test.nestcfg.outer"],
  input: z.object({ name: z.string() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { name }) => {
    const id = await insertProbe(ctx.tx, ctx.companyId, name);
    if (flaky.fails) throw new ProcessError("invalid_input", "flaky", { details: ["Falla por ahora"] });
    return { id };
  },
});
const asParent = defineProcess({
  id: "test.nestcfg.as_parent",
  module: "test",
  kind: "create",
  description: "se hace pasar por otro padre",
  input: z.object({}),
  output: z.unknown(),
  handler: async (ctx) => (await ctx.runProcess!("test.nestcfg.inner", { name: "asp-in" }, { asParent: "test.nestcfg.outer" })) ?? null,
});

const TEST_PROCESSES = [outer, outerSu, inner, sensitive, only, middle, chain, flakyProcess, flakySu, flakyOnly, asParent];

const testModule: ModuleDef = {
  id: "test",
  version: "0.0.1",
  dependsOn: [],
  entities: [],
  processes: TEST_PROCESSES,
  features: [],
  events: { emits: ["test.nestcfg.inner_done"], consumes: {} },
  navigation: [],
};
const ledgerModule: ModuleDef = {
  id: "testledger",
  version: "0.0.1",
  dependsOn: [],
  entities: [],
  processes: [posting],
  features: [],
  events: { emits: ["test.nestcfg.posted"], consumes: {} },
  navigation: [],
  // The ledger side: a posting rule on the posting process's event (the template is never composed here).
  postingRules: [{ event: "test.nestcfg.posted", name: "prueba", journalCode: "GJ", template: {} as never }],
};

describe("configurable nested runs (plan 2B Task 32)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let deps: { sql: ReturnType<typeof testDb>; registry: Registry };
  let companyId: string;
  let companyB: string;
  let admin: Caller;
  let adminB: Caller;
  let plain: Caller;
  let granted: Caller;
  let dismisser: Caller;
  let retrierRole: string;

  const insertVerification = async (userId: string, at = new Date()) => {
    const token = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, verified_at, token) values (${userId}, ${companyId}, ${at}, ${token})`;
    return token;
  };
  const withStepUp = async (caller: Caller, chainId?: string): Promise<Caller> => ({ ...caller, stepUpToken: await insertVerification(caller.claims.sub), ...(chainId ? { chainId } : {}) });
  const onChain = (caller: Caller, chainId = randomUUID()): Caller => ({ ...caller, chainId });
  const run = (caller: Caller, processId: string, input: unknown) => runProcess(deps, caller, processId, input);
  const probes = async (prefix: string) =>
    (await sql<{ secret: string }[]>`select secret from kernel.role_probe where company_id = ${companyId} and secret like ${prefix + "-%"} order by secret`).map((r) => r.secret);
  const setPair = (parent: string, nested: string, covers: boolean, onFailure: "rollback" | "continue") =>
    sql`insert into kernel.nested_run_pairs (company_id, parent_process, nested_process, parent_totp_covers, on_failure)
        values (${companyId}, ${parent}, ${nested}, ${covers}, ${onFailure})
        on conflict (company_id, parent_process, nested_process) do update set parent_totp_covers = excluded.parent_totp_covers, on_failure = excluded.on_failure`;
  const clearPairs = () => sql`delete from kernel.nested_run_pairs where company_id = ${companyId}`;
  const grant = (roleId: string, processId: string) =>
    sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, ${processId}) on conflict do nothing`;
  const auditOf = (chainId: string) =>
    sql<{ process_id: string; entity: string; action: string; input: Record<string, unknown> | null; origin: string; actor_user_id: string }[]>`
      select process_id, entity, action, input, origin, actor_user_id from kernel.audit_log where chain_id = ${chainId} order by id`;
  const failuresOf = (chainId: string) => sql<Record<string, unknown>[]>`select * from kernel.nested_run_failures where chain_id = ${chainId}`;
  /** A pending queue row through a real continue run of outer → flaky. */
  const queueFlaky = async (name: string): Promise<{ id: string; chainId: string }> => {
    await setPair("test.nestcfg.outer", "test.nestcfg.flaky", false, "continue");
    flaky.fails = true;
    const chainId = randomUUID();
    await run(onChain(admin, chainId), "test.nestcfg.outer", { target: "test.nestcfg.flaky", input: { name: `${name}-in` }, name });
    const [row] = await failuresOf(chainId);
    return { id: row!.id as string, chainId };
  };

  beforeAll(async () => {
    sql = testDb();
    await ensureRoleProbe(sql);
    await sql`grant insert on kernel.role_probe to authenticated`;
    await sql`select kernel.enable_row_audit('kernel', 'role_probe')`;
    registry = new Registry();
    loadModules(registry, [kernelModule, testModule, ledgerModule]);
    deps = { sql, registry };
    seed = await seedTenant(sql, {
      companies: 2,
      entitlements: ["module:test", "module:testledger"],
      users: [
        { name: "plain", companies: [0], role: "member" },
        { name: "granted", companies: [0], role: "member" },
        { name: "dismisser", companies: [0], role: "member" },
      ],
    });
    companyId = seed.companies[0]!.id;
    companyB = seed.companies[1]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };
    adminB = { claims: seed.claimsFor(seed.users.both, companyB) as JwtClaims, origin: "ui" };
    plain = { claims: seed.claimsFor(seed.users.plain!, companyId) as JwtClaims, origin: "ui" };
    const [role] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'retrier', false) returning id`;
    retrierRole = role!.id;
    await seed.holdRoles(seed.users.granted!, companyId, [retrierRole]);
    const grantedClaims = seed.claimsFor(seed.users.granted!, companyId) as JwtClaims;
    granted = { claims: { ...grantedClaims, role_ids: [...grantedClaims.role_ids, retrierRole] }, origin: "ui" };
    // The plain role may run the parents and the nested processes (so a refusal is about the nested-run gate, not the parent's).
    for (const id of ["test.nestcfg.outer", "test.nestcfg.outer_su", "test.nestcfg.inner"]) await grant(seed.companies[0]!.memberRoleId, id);
    for (const id of ["kernel.nested_failure.retry", "kernel.nested_failure.dismiss", "test.nestcfg.flaky"]) await grant(retrierRole, id);
    // A role granted only the dismissal (fix round 1, M9: it sees the queue too).
    const [dRole] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'dismisser', false) returning id`;
    await seed.holdRoles(seed.users.dismisser!, companyId, [dRole!.id]);
    await grant(dRole!.id, "kernel.nested_failure.dismiss");
    const dClaims = seed.claimsFor(seed.users.dismisser!, companyId) as JwtClaims;
    dismisser = { claims: { ...dClaims, role_ids: [...dClaims.role_ids, dRole!.id] }, origin: "ui" };
    // The failure queue names registered processes only.
    for (const p of TEST_PROCESSES) {
      await sql`insert into kernel.registered_processes (process_id, module_id, kind) values (${p.id}, 'test', ${p.kind}) on conflict (process_id) do nothing`;
    }
    await sql`insert into kernel.registered_processes (process_id, module_id, kind) values ('testledger.posting', 'testledger', 'create') on conflict (process_id) do nothing`;
  });
  afterAll(async () => {
    await sql`drop trigger if exists audit_row_change on kernel.role_probe`;
    await sql`delete from kernel.registered_processes where process_id like 'test.nestcfg.%' or process_id = 'testledger.posting'`;
    await sql`delete from kernel.role_probe where company_id = any(${[companyId, companyB]}::uuid[])`;
    await seed.cleanup();
    await sql.end();
  });

  describe("1. defaults reproduce the fixed behaviour", () => {
    it("allows four levels and refuses the fifth with the same message", async () => {
      await expect(run(admin, "test.nestcfg.chain", { level: 4, name: "d4" })).resolves.toEqual({ ok: true });
      expect(await probes("d4")).toHaveLength(5);
      const error = await run(admin, "test.nestcfg.chain", { level: 5, name: "d5" }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "handler_failed", message: "test.nestcfg.chain: nested runs are limited to 4 levels" });
      expect(await probes("d5")).toEqual([]);
    });

    it("refuses a step-up nested process and rolls the whole run back on a nested failure", async () => {
      await expect(run(admin, "test.nestcfg.outer", { target: "test.nestcfg.sensitive", input: { name: "s0-in" }, name: "s0" })).rejects.toMatchObject({ code: "step_up_required" });
      await expect(run(admin, "test.nestcfg.outer", { target: "test.nestcfg.inner", input: { name: "f0-in", fail: "invalid" }, name: "f0" })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(run(admin, "test.nestcfg.outer", { target: "test.nestcfg.inner", input: { name: "b0-in", fail: "boom" }, name: "b0" })).rejects.toMatchObject({ code: "handler_failed" });
      expect([...(await probes("s0")), ...(await probes("f0")), ...(await probes("b0"))]).toEqual([]);
      expect(await sql`select 1 from kernel.nested_run_failures where company_id = ${companyId}`).toHaveLength(0);
    });

    it("a run with nothing queued keeps its audit input unchanged", async () => {
      const chainId = randomUUID();
      await run(onChain(admin, chainId), "test.nestcfg.outer", { target: "test.nestcfg.inner", input: { name: "plain0-in" }, name: "plain0" });
      const own = (await auditOf(chainId)).filter((r) => r.process_id === "test.nestcfg.outer" && r.entity === "test.nestcfg");
      expect(own).toHaveLength(1);
      expect(own[0]!.input).toEqual({ target: "test.nestcfg.inner", input: { name: "plain0-in" }, name: "plain0" });
    });
  });

  describe("2. step-up coverage", () => {
    afterAll(clearPairs);

    it("a covering pair runs the step-up nested process on the parent's fresh token, consumed once", async () => {
      await setPair("test.nestcfg.outer_su", "test.nestcfg.sensitive", true, "rollback");
      const caller = await withStepUp(admin);
      const out = (await run(caller, "test.nestcfg.outer_su", { target: "test.nestcfg.sensitive", input: { name: "cov-in" }, name: "cov" })) as { inner: { id: string } };
      expect(out.inner.id).toBeTruthy();
      expect(await probes("cov")).toEqual(["cov-after", "cov-before", "cov-in"]);
      const rows = await sql`select consumed_at from kernel.step_up_verifications where token = ${caller.stepUpToken!}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.consumed_at).not.toBeNull();
      // The same token, consumed by that run, covers nothing again.
      await expect(run(caller, "test.nestcfg.outer_su", { target: "test.nestcfg.sensitive", input: { name: "again-in" }, name: "again" })).rejects.toMatchObject({ code: "step_up_required" });
    });

    it("refuses with the flag off, a stale token, another user's token and a non-sensitive parent", async () => {
      await setPair("test.nestcfg.outer_su", "test.nestcfg.sensitive", false, "rollback");
      await expect(run(await withStepUp(admin), "test.nestcfg.outer_su", { target: "test.nestcfg.sensitive", input: { name: "off-in" }, name: "off" })).rejects.toMatchObject({ code: "step_up_required" });
      await setPair("test.nestcfg.outer_su", "test.nestcfg.sensitive", true, "rollback");
      const stale = { ...admin, stepUpToken: await insertVerification(admin.claims.sub, new Date(Date.now() - 6 * 60_000)) };
      await expect(run(stale, "test.nestcfg.outer_su", { target: "test.nestcfg.sensitive", input: { name: "stale-in" }, name: "stale" })).rejects.toMatchObject({ code: "step_up_required" });
      const others = { ...admin, stepUpToken: await insertVerification(seed.users.plain!) };
      await expect(run(others, "test.nestcfg.outer_su", { target: "test.nestcfg.sensitive", input: { name: "other-in" }, name: "other" })).rejects.toMatchObject({ code: "step_up_required" });
      // A parent that is not step-up consumes nothing: a fresh token it carries never covers.
      await setPair("test.nestcfg.outer", "test.nestcfg.sensitive", true, "rollback");
      const fresh = await withStepUp(admin);
      await expect(run(fresh, "test.nestcfg.outer", { target: "test.nestcfg.sensitive", input: { name: "ns-in" }, name: "ns" })).rejects.toMatchObject({ code: "step_up_required" });
      const [token] = await sql`select consumed_at from kernel.step_up_verifications where token = ${fresh.stepUpToken!}`;
      expect(token!.consumed_at).toBeNull();
      expect([...(await probes("off")), ...(await probes("stale")), ...(await probes("other")), ...(await probes("ns"))]).toEqual([]);
    });

    it("a token consumed by an earlier run reaches the nested coverage check and never covers (fix round 1, M8)", async () => {
      // A step-up parent refuses a consumed token at its own gate; a parent that is not step-up lets the run reach the nested check,
      // where consumed_at is the earlier transaction's now(), not this one's.
      await setPair("test.nestcfg.outer", "test.nestcfg.sensitive", true, "rollback");
      const caller = await withStepUp(admin);
      await sql`update kernel.step_up_verifications set consumed_at = now() - interval '1 minute' where token = ${caller.stepUpToken!}`;
      const error = await run(caller, "test.nestcfg.outer", { target: "test.nestcfg.sensitive", input: { name: "used-in" }, name: "used" }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "step_up_required", message: expect.stringMatching(/cannot run nested in test\.nestcfg\.outer/) });
      expect(await probes("used")).toEqual([]);
    });

    it("a nestedOnlyFrom process is unaffected (no pair needed)", async () => {
      await clearPairs();
      await run(await withStepUp(admin), "test.nestcfg.outer_su", { target: "test.nestcfg.only", input: { name: "onl-in" }, name: "onl" });
      expect(await probes("onl")).toEqual(["onl-after", "onl-before", "onl-in"]);
    });
  });

  describe("3. continue and queue", () => {
    beforeAll(() => setPair("test.nestcfg.outer", "test.nestcfg.inner", false, "continue"));
    afterAll(clearPairs);

    it("undoes only the savepoint, commits the parent, queues one row and audits both sides", async () => {
      const chainId = randomUUID();
      const out = (await run(onChain(admin, chainId), "test.nestcfg.outer", { target: "test.nestcfg.inner", input: { name: "q1-in", fail: "invalid" }, name: "q1" })) as { first: string; inner: unknown; last: string };
      // ctx.runProcess resolved undefined; the parent's writes are committed, the nested probe, its event and its afterCommit step are gone.
      expect(out.inner).toBeNull();
      expect(await probes("q1")).toEqual(["q1-after", "q1-before"]);
      expect(await sql`select 1 from kernel.outbox where chain_id = ${chainId} and event = 'test.nestcfg.inner_done'`).toHaveLength(0);
      const failures = await failuresOf(chainId);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        company_id: companyId,
        parent_process: "test.nestcfg.outer",
        nested_process: "test.nestcfg.inner",
        input: { name: "q1-in", fail: "invalid" },
        error_code: "invalid_input",
        reason: "La prueba falló a propósito",
        actor_user_id: admin.claims.sub,
        origin: "ui",
        status: "pending",
        attempts: 0,
      });
      const failureId = failures[0]!.id as string;
      const audit = await auditOf(chainId);
      // No row of the nested run's writes is left, the probes around it are the parent's (its audit context again afterwards).
      const probeRows = audit.filter((r) => r.entity === "kernel.role_probe");
      expect(new Set(probeRows.map((r) => r.process_id))).toEqual(new Set(["test.nestcfg.outer"]));
      const nestedQueued = audit.find((r) => r.process_id === "test.nestcfg.inner" && r.input?.code === "nested_run_queued");
      expect(nestedQueued).toMatchObject({ action: "insert", origin: "ui", actor_user_id: admin.claims.sub, input: { code: "nested_run_queued", error_code: "invalid_input", failure_id: failureId } });
      const parentQueued = audit.find((r) => r.process_id === "test.nestcfg.outer" && r.input?.code === "nested_run_queued");
      expect(parentQueued).toMatchObject({ origin: "ui", actor_user_id: admin.claims.sub, input: { code: "nested_run_queued", nested_process: "test.nestcfg.inner", failure_id: failureId } });
      const success = audit.find((r) => r.process_id === "test.nestcfg.outer" && r.entity === "test.nestcfg" && r.input?.name === "q1");
      expect(success!.input!.nested_queued).toEqual([{ process: "test.nestcfg.inner", failure_id: failureId }]);
      expect(audit.some((r) => r.process_id === "test.nestcfg.inner" && r.input?.name === "q1-in")).toBe(false);
    });

    it("a nested run that succeeds hands its afterCommit step to the parent", async () => {
      await run(admin, "test.nestcfg.outer", { target: "test.nestcfg.inner", input: { name: "ok1-in" }, name: "ok1" });
      expect(await probes("ok1")).toEqual(["ok1-after", "ok1-before", "ok1-in", "ok1-in-ac"]);
    });

    it("contains a SQL error of the nested handler and stores a safe reason", async () => {
      const chainId = randomUUID();
      await run(onChain(admin, chainId), "test.nestcfg.outer", { target: "test.nestcfg.inner", input: { name: "sq-in", fail: "sql" }, name: "sq" });
      expect(await probes("sq")).toEqual(["sq-after", "sq-before"]);
      const [row] = await failuresOf(chainId);
      expect(row).toMatchObject({ error_code: "handler_failed", status: "pending" });
      expect(row!.reason).not.toMatch(/duplicate|constraint|role_probe/);
      // A plain handler failure: the message never reaches the queue.
      const boom = randomUUID();
      await run(onChain(admin, boom), "test.nestcfg.outer", { target: "test.nestcfg.inner", input: { name: "bm-in", fail: "boom" }, name: "bm" });
      const [boomRow] = await failuresOf(boom);
      expect(boomRow!.reason).not.toMatch(/boom|secret/);
    });
  });

  describe("4. continue is refused for a ledger or stock process", () => {
    afterAll(clearPairs);

    it("pair.set refuses continue on a process whose emits hit a posting rule", async () => {
      const error = await run(await withStepUp(admin), "kernel.admin.nested_run.pair.set", { parent: "test.nestcfg.outer", nested: "testledger.posting", totpCovers: false, onFailure: "continue" }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "invalid_input", details: ["Una ejecución anidada que contabiliza o mueve existencias no puede continuar tras un fallo"] });
      // Roll back all is accepted.
      await expect(run(await withStepUp(admin), "kernel.admin.nested_run.pair.set", { parent: "test.nestcfg.outer", nested: "testledger.posting", totpCovers: false, onFailure: "rollback" })).resolves.toMatchObject({ id: expect.any(String) });
    });

    it("a stored continue of such a pair runs as rollback, with the nested_continue_refused note", async () => {
      await setPair("test.nestcfg.outer", "testledger.posting", false, "continue");
      await expect(run(admin, "test.nestcfg.outer", { target: "testledger.posting", input: { name: "lp-in", fail: true }, name: "lp" })).rejects.toMatchObject({ code: "invalid_input" });
      expect(await probes("lp")).toEqual([]);
      const chainId = randomUUID();
      await run(onChain(admin, chainId), "test.nestcfg.outer", { target: "testledger.posting", input: { name: "lpok-in" }, name: "lpok" });
      const note = (await auditOf(chainId)).find((r) => r.input?.code === "nested_continue_refused");
      expect(note).toMatchObject({ process_id: "test.nestcfg.outer", input: { code: "nested_continue_refused", nested_process: "testledger.posting" } });
      expect(await sql`select 1 from kernel.nested_run_failures where company_id = ${companyId} and nested_process = 'testledger.posting'`).toHaveLength(0);
    });

    it("the run-time collector refuses to continue when the nested subtree emitted a ledger event", async () => {
      await setPair("test.nestcfg.outer", "test.nestcfg.middle", false, "continue");
      const chainId = randomUUID();
      const error = await run(onChain(admin, chainId), "test.nestcfg.outer", {
        target: "test.nestcfg.middle",
        input: { name: "col-mid", target: "testledger.posting", input: { name: "col-post" } },
        name: "col",
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "invalid_input", details: ["Falla después"] });
      expect(await probes("col")).toEqual([]);
      expect(await failuresOf(chainId)).toHaveLength(0);
      // The same middle process over a harmless nested run is queued.
      const harmless = randomUUID();
      await run(onChain(admin, harmless), "test.nestcfg.outer", { target: "test.nestcfg.middle", input: { name: "hm-mid", target: "test.nestcfg.inner", input: { name: "hm-in" } }, name: "hm" });
      expect(await probes("hm")).toEqual(["hm-after", "hm-before"]);
      expect(await failuresOf(harmless)).toHaveLength(1);
    });
  });

  describe("5. depth", () => {
    afterAll(() => sql`delete from kernel.nested_run_settings where company_id = ${companyId}`);

    it("depth.set 6 allows six levels and refuses the seventh; 9 is refused by zod and by the check; no row means 4", async () => {
      await expect(run(await withStepUp(admin), "kernel.admin.nested_run.depth.set", { maxDepth: 6 })).resolves.toMatchObject({ id: expect.any(String) });
      await expect(run(admin, "test.nestcfg.chain", { level: 6, name: "e6" })).resolves.toEqual({ ok: true });
      await expect(run(admin, "test.nestcfg.chain", { level: 7, name: "e7" })).rejects.toMatchObject({ code: "handler_failed", message: "test.nestcfg.chain: nested runs are limited to 6 levels" });
      expect(await probes("e7")).toEqual([]);
      await expect(run(await withStepUp(admin), "kernel.admin.nested_run.depth.set", { maxDepth: 9 })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(sql`update kernel.nested_run_settings set max_depth = 9 where company_id = ${companyId}`).rejects.toMatchObject({ code: "23514" });
      await sql`delete from kernel.nested_run_settings where company_id = ${companyId}`;
      await expect(run(admin, "test.nestcfg.chain", { level: 5, name: "e5" })).rejects.toMatchObject({ message: "test.nestcfg.chain: nested runs are limited to 4 levels" });
    });
  });

  describe("6. denials always propagate", () => {
    beforeAll(() => setPair("test.nestcfg.outer", "test.nestcfg.inner", false, "continue"));
    afterAll(clearPairs);

    it("a caller without the nested process's role is refused forbidden in continue mode too, and a handler denial propagates", async () => {
      await sql`delete from kernel.process_permissions where company_id = ${companyId} and role_id = ${seed.companies[0]!.memberRoleId} and process_id = 'test.nestcfg.inner'`;
      try {
        const chainId = randomUUID();
        await expect(run(onChain(plain, chainId), "test.nestcfg.outer", { target: "test.nestcfg.inner", input: { name: "dn-in" }, name: "dn" })).rejects.toMatchObject({ code: "forbidden" });
        expect(await probes("dn")).toEqual([]);
        expect(await failuresOf(chainId)).toHaveLength(0);
      } finally {
        await grant(seed.companies[0]!.memberRoleId, "test.nestcfg.inner");
      }
      const chainId = randomUUID();
      await expect(run(onChain(admin, chainId), "test.nestcfg.outer", { target: "test.nestcfg.inner", input: { name: "hd-in", fail: "forbidden" }, name: "hd" })).rejects.toMatchObject({ code: "forbidden" });
      expect(await probes("hd")).toEqual([]);
      expect(await failuresOf(chainId)).toHaveLength(0);
      // A SQL denial (insufficient_privilege from a definer writer) inside the nested handler propagates as a denial, never queued (M1).
      const priv = randomUUID();
      await expect(run(onChain(admin, priv), "test.nestcfg.outer", { target: "test.nestcfg.inner", input: { name: "pv-in", fail: "privilege" }, name: "pv" })).rejects.toMatchObject({ code: "forbidden" });
      expect(await probes("pv")).toEqual([]);
      expect(await failuresOf(priv)).toHaveLength(0);
      // A step-up nested process in continue mode without coverage is refused too.
      await setPair("test.nestcfg.outer", "test.nestcfg.sensitive", false, "continue");
      await expect(run(admin, "test.nestcfg.outer", { target: "test.nestcfg.sensitive", input: { name: "su-in" }, name: "su" })).rejects.toMatchObject({ code: "step_up_required" });
    });
  });

  describe("7. retry and dismiss", () => {
    afterAll(clearPairs);

    it("an admin's retry re-runs the nested process in the pair's context, resolves the row and audits it with retry_of", async () => {
      const queued = await queueFlaky("rt1");
      flaky.fails = false;
      const retryChain = randomUUID();
      const out = await run(await withStepUp(admin, retryChain), "kernel.nested_failure.retry", { id: queued.id });
      expect(out).toEqual({ id: queued.id, status: "resolved" });
      expect(await probes("rt1")).toEqual(["rt1-after", "rt1-before", "rt1-in"]);
      const [row] = await sql`select * from kernel.nested_run_failures where id = ${queued.id}`;
      expect(row).toMatchObject({ status: "resolved", attempts: 1, retry_chain_id: retryChain, resolved_by: admin.claims.sub, chain_id: queued.chainId, actor_user_id: admin.claims.sub });
      const audit = await auditOf(retryChain);
      expect(audit.some((r) => r.process_id === "test.nestcfg.flaky" && r.input?.name === "rt1-in")).toBe(true);
      const own = audit.find((r) => r.process_id === "kernel.nested_failure.retry" && r.input?.retry_of === queued.id && r.input?.original_chain_id === queued.chainId);
      expect(own).toBeDefined();
      // The retry's own success row (its input `id`) carries the marks too (fix round 1, M6).
      const success = audit.find((r) => r.process_id === "kernel.nested_failure.retry" && r.input?.id === queued.id);
      expect(success!.input).toEqual({ id: queued.id, retry_of: queued.id, original_chain_id: queued.chainId, original_actor_id: admin.claims.sub });
      expect(audit.some((r) => r.process_id === "test.nestcfg.flaky" && r.input?.retry_of === queued.id && r.input?.original_actor_id === admin.claims.sub)).toBe(true);
    });

    it("a failing retry leaves the row pending and surfaces the error", async () => {
      const queued = await queueFlaky("rt2");
      await expect(run(await withStepUp(admin), "kernel.nested_failure.retry", { id: queued.id })).rejects.toMatchObject({ code: "invalid_input", details: ["Falla por ahora"] });
      const [row] = await sql`select status, attempts from kernel.nested_run_failures where id = ${queued.id}`;
      expect(row).toEqual({ status: "pending", attempts: 0 });
      expect(await probes("rt2")).toEqual(["rt2-after", "rt2-before"]);
    });

    it("a granted role retries and dismisses; an ungranted role is forbidden; a closed row is not_found", async () => {
      const queued = await queueFlaky("rt3");
      await expect(run(await withStepUp(plain), "kernel.nested_failure.retry", { id: queued.id })).rejects.toMatchObject({ code: "forbidden" });
      await expect(run(plain, "kernel.nested_failure.dismiss", { id: queued.id })).rejects.toMatchObject({ code: "forbidden" });
      await expect(run(granted, "kernel.nested_failure.retry", { id: queued.id })).rejects.toMatchObject({ code: "step_up_required" });
      flaky.fails = false;
      await expect(run(await withStepUp(granted), "kernel.nested_failure.retry", { id: queued.id })).resolves.toEqual({ id: queued.id, status: "resolved" });
      await expect(run(await withStepUp(admin), "kernel.nested_failure.retry", { id: queued.id })).rejects.toMatchObject({ code: "not_found" });

      const toDismiss = await queueFlaky("rt4");
      await expect(run(granted, "kernel.nested_failure.dismiss", { id: toDismiss.id })).resolves.toEqual({ id: toDismiss.id });
      const [row] = await sql`select status, dismissed_by from kernel.nested_run_failures where id = ${toDismiss.id}`;
      expect(row).toEqual({ status: "dismissed", dismissed_by: granted.claims.sub });
      await expect(run(await withStepUp(admin), "kernel.nested_failure.retry", { id: toDismiss.id })).rejects.toMatchObject({ code: "not_found" });
      await expect(run(granted, "kernel.nested_failure.dismiss", { id: toDismiss.id })).rejects.toMatchObject({ code: "not_found" });
    });

    it("a role granted only the retry cannot replay a nestedOnlyFrom process whose parent it cannot run; an admin can (fix round 1, I2)", async () => {
      await setPair("test.nestcfg.outer", "test.nestcfg.flaky_only", false, "continue");
      flaky.fails = true;
      const chainId = randomUUID();
      await run(onChain(admin, chainId), "test.nestcfg.outer", { target: "test.nestcfg.flaky_only", input: { name: "fo-in" }, name: "fo" });
      const [row] = await failuresOf(chainId);
      flaky.fails = false;
      // The granted user's member role may run the parent in the other tests: take it away for this one.
      await sql`delete from kernel.process_permissions where company_id = ${companyId} and role_id = ${seed.companies[0]!.memberRoleId} and process_id = 'test.nestcfg.outer'`;
      try {
        await expect(run(await withStepUp(granted), "kernel.nested_failure.retry", { id: row!.id })).rejects.toMatchObject({ code: "forbidden" });
      } finally {
        await grant(seed.companies[0]!.memberRoleId, "test.nestcfg.outer");
      }
      expect(await probes("fo")).toEqual(["fo-after", "fo-before"]);
      await expect(run(await withStepUp(admin), "kernel.nested_failure.retry", { id: row!.id })).resolves.toEqual({ id: row!.id, status: "resolved" });
      expect(await probes("fo")).toEqual(["fo-after", "fo-before", "fo-in"]);
    });

    it("a retry's own step-up covers a step-up nested process under a covering pair, and not without it (fix round 1, M8)", async () => {
      await setPair("test.nestcfg.outer_su", "test.nestcfg.flaky_su", true, "continue");
      flaky.fails = true;
      const chainId = randomUUID();
      await run(await withStepUp(admin, chainId), "test.nestcfg.outer_su", { target: "test.nestcfg.flaky_su", input: { name: "fsu-in" }, name: "fsu" });
      const [row] = await failuresOf(chainId);
      expect(row).toMatchObject({ status: "pending", nested_process: "test.nestcfg.flaky_su" });
      flaky.fails = false;
      await setPair("test.nestcfg.outer_su", "test.nestcfg.flaky_su", false, "continue");
      await expect(run(await withStepUp(admin), "kernel.nested_failure.retry", { id: row!.id })).rejects.toMatchObject({ code: "step_up_required" });
      await setPair("test.nestcfg.outer_su", "test.nestcfg.flaky_su", true, "continue");
      await expect(run(await withStepUp(admin), "kernel.nested_failure.retry", { id: row!.id })).resolves.toEqual({ id: row!.id, status: "resolved" });
      expect(await probes("fsu")).toEqual(["fsu-after", "fsu-before", "fsu-in"]);
    });

    it("asParent passed by any other handler is forbidden", async () => {
      await expect(run(admin, "test.nestcfg.as_parent", {})).rejects.toMatchObject({ code: "forbidden" });
      expect(await probes("asp")).toEqual([]);
    });
  });

  describe("8. RLS and masking", () => {
    let failureId: string;
    beforeAll(async () => {
      failureId = (await queueFlaky("rls")).id;
      await sql`insert into kernel.nested_run_settings (company_id, max_depth) values (${companyId}, 5) on conflict (company_id) do nothing`;
    });
    afterAll(async () => {
      await clearPairs();
      await sql`delete from kernel.nested_run_settings where company_id = ${companyId}`;
    });

    const count = (caller: Caller, table: string) =>
      withClaims(sql, caller.claims, async (tx) => Number((await tx.unsafe<{ n: string }[]>(`select count(*) as n from ${table}`))[0]!.n));

    it("company B's admin sees nothing of company A; a plain role sees no queue row and no pair; a granted role sees the queue", async () => {
      for (const table of ["kernel.nested_run_pairs", "kernel.nested_run_settings", "kernel.v_nested_run_failures"]) {
        expect(await count(adminB, table), table).toBe(0);
        expect(await count(plain, table), table).toBe(0);
        expect(await count(admin, table), table).toBeGreaterThan(0);
      }
      expect(await count(granted, "kernel.v_nested_run_failures")).toBeGreaterThan(0);
      // A role granted only the dismissal sees the queue too (fix round 1, M9, migration 0127), and still no pair.
      expect(await count(dismisser, "kernel.v_nested_run_failures")).toBeGreaterThan(0);
      expect(await count(dismisser, "kernel.nested_run_pairs")).toBe(0);
      expect(await count(granted, "kernel.nested_run_pairs")).toBe(0);
      const [row] = await withClaims(sql, granted.claims, (tx) => tx`select parent_process, reason, status from kernel.v_nested_run_failures where id = ${failureId}`);
      expect(row).toMatchObject({ parent_process: "test.nestcfg.outer", status: "pending" });
    });

    it("the raw input is never readable by a user, and direct writes are refused", async () => {
      for (const caller of [admin, granted]) {
        await expect(withClaims(sql, caller.claims, (tx) => tx`select input from kernel.nested_run_failures`)).rejects.toMatchObject({ code: "42501" });
      }
      const writes = [
        `insert into kernel.nested_run_pairs (company_id, parent_process, nested_process) values ('${companyId}', 'a.b.c', 'a.b.d')`,
        `update kernel.nested_run_pairs set on_failure = 'continue'`,
        `delete from kernel.nested_run_pairs`,
        `insert into kernel.nested_run_settings (company_id, max_depth) values ('${companyId}', 3)`,
        `update kernel.nested_run_settings set max_depth = 2`,
        `delete from kernel.nested_run_settings`,
        `update kernel.nested_run_failures set status = 'resolved'`,
        `delete from kernel.nested_run_failures`,
        `insert into kernel.nested_run_failures (company_id, parent_process, nested_process, input, error_code, reason, chain_id, actor_user_id, origin) values ('${companyId}', 'a.b.c', 'a.b.d', '{}', 'x', 'x', gen_random_uuid(), gen_random_uuid(), 'ui')`,
      ];
      for (const statement of writes) {
        await expect(withClaims(sql, admin.claims, (tx) => tx.unsafe(statement)), statement).rejects.toMatchObject({ code: "42501" });
      }
    });

    it("the definer writers refuse without the matching process; nested_failure_record refuses a pair that is not continue", async () => {
      const inRun = <T>(processId: string, fn: (tx: Tx) => Promise<T>) =>
        withClaims(sql, admin.claims, async (tx) => {
          await tx`select set_config('erp.audit_process_id', ${processId}, true)`;
          return fn(tx);
        });
      await expect(inRun("kernel.admin.nested_run.depth.set", (tx) => tx`select kernel.nested_run_pair_set('test.nestcfg.outer', 'test.nestcfg.inner', false, 'continue')`)).rejects.toMatchObject({ code: "42501" });
      await expect(inRun("kernel.admin.nested_run.pair.set", (tx) => tx`select kernel.nested_run_depth_set(5)`)).rejects.toMatchObject({ code: "42501" });
      await setPair("test.nestcfg.outer", "test.nestcfg.sensitive", false, "rollback");
      const record = (tx: Tx) => tx`select kernel.nested_failure_record('test.nestcfg.outer', 'test.nestcfg.sensitive', '{}'::jsonb, 'invalid_input', 'x', ${randomUUID()}::uuid, 'ui')`;
      await expect(inRun("test.nestcfg.outer", record)).rejects.toMatchObject({ code: "42501" });
      // A plain member's session cannot take or close a row even inside the named run.
      await expect(
        withClaims(sql, plain.claims, async (tx) => {
          await tx`select set_config('erp.audit_process_id', 'kernel.nested_failure.retry', true)`;
          return tx`select * from kernel.nested_failure_take(${failureId}::uuid)`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("the 90-day purge removes only resolved and dismissed rows", async () => {
      const old = new Date(Date.now() - 91 * 86_400_000);
      const insert = (status: string, at: Date) =>
        sql<{ id: string }[]>`insert into kernel.nested_run_failures (company_id, parent_process, nested_process, input, error_code, reason, chain_id, actor_user_id, origin, status, created_at,
                                                           resolved_at, dismissed_at)
                values (${companyId}, 'test.nestcfg.outer', 'test.nestcfg.flaky', '{}', 'invalid_input', 'x', ${randomUUID()}, ${admin.claims.sub}, 'ui', ${status}, ${at},
                        ${status === "resolved" ? at : null}, ${status === "dismissed" ? at : null}) returning id`;
      const [oldResolved] = await insert("resolved", old);
      const [oldDismissed] = await insert("dismissed", old);
      const [oldPending] = await insert("pending", old);
      const [recentResolved] = await insert("resolved", new Date());
      await queueFlaky("purge");
      const left = (await sql<{ id: string }[]>`select id from kernel.nested_run_failures where id = any(${[oldResolved!.id, oldDismissed!.id, oldPending!.id, recentResolved!.id]}::uuid[])`).map((r) => r.id);
      expect(left.sort()).toEqual([oldPending!.id, recentResolved!.id].sort());
    });
  });

  describe("9. the configuration processes", () => {
    afterAll(clearPairs);

    it("need step-up, refuse a non-admin and unknown or invalid pairs, and audit their input", async () => {
      const input = { parent: "test.nestcfg.outer_su", nested: "test.nestcfg.sensitive", totpCovers: true, onFailure: "rollback" };
      await expect(run(admin, "kernel.admin.nested_run.pair.set", input)).rejects.toMatchObject({ code: "step_up_required" });
      await expect(run(admin, "kernel.admin.nested_run.depth.set", { maxDepth: 5 })).rejects.toMatchObject({ code: "step_up_required" });
      await grant(seed.companies[0]!.memberRoleId, "kernel.admin.nested_run.pair.set");
      await expect(run(await withStepUp(plain), "kernel.admin.nested_run.pair.set", input)).rejects.toMatchObject({ code: "forbidden" });
      const refused = async (over: Record<string, unknown>, detail: RegExp) => {
        const error = (await run(await withStepUp(admin), "kernel.admin.nested_run.pair.set", { ...input, ...over }).catch((e: unknown) => e)) as { code: string; details: string[] };
        expect(error.code).toBe("invalid_input");
        expect(error.details.join(" ")).toMatch(detail);
      };
      await refused({ parent: "test.nestcfg.nope" }, /test\.nestcfg\.nope/);
      await refused({ nested: "test.nestcfg.nope" }, /test\.nestcfg\.nope/);
      await refused({ nested: "test.nestcfg.outer_su" }, /sí mismo/);
      await refused({ parent: "test.nestcfg.outer", nested: "test.nestcfg.only" }, /Ese proceso solo corre dentro de: test\.nestcfg\.outer_su/);

      const chainId = randomUUID();
      const out = (await run(await withStepUp(admin, chainId), "kernel.admin.nested_run.pair.set", input)) as { id: string };
      const [pair] = await sql`select parent_process, nested_process, parent_totp_covers, on_failure, seq from kernel.nested_run_pairs where id = ${out.id}`;
      expect(pair).toMatchObject({ parent_process: input.parent, nested_process: input.nested, parent_totp_covers: true, on_failure: "rollback" });
      // A second save of the same pair updates the row (no new seq).
      const again = (await run(await withStepUp(admin), "kernel.admin.nested_run.pair.set", { ...input, totpCovers: false })) as { id: string };
      expect(again.id).toBe(out.id);
      const [after] = await sql`select parent_totp_covers, seq from kernel.nested_run_pairs where id = ${out.id}`;
      expect(after).toMatchObject({ parent_totp_covers: false, seq: pair!.seq });
      const audit = (await auditOf(chainId)).find((r) => r.process_id === "kernel.admin.nested_run.pair.set" && r.entity !== "kernel.nested_run_pairs");
      expect(audit!.input).toEqual(input);

      const depthChain = randomUUID();
      await run(await withStepUp(admin, depthChain), "kernel.admin.nested_run.depth.set", { maxDepth: 5 });
      expect((await auditOf(depthChain)).find((r) => r.process_id === "kernel.admin.nested_run.depth.set" && r.entity !== "kernel.nested_run_settings")!.input).toEqual({ maxDepth: 5 });
      await sql`delete from kernel.nested_run_settings where company_id = ${companyId}`;
    });
  });
});
