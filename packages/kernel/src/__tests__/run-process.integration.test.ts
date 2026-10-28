import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { withClaims, type JwtClaims, type Tx } from "../db/client";
import { testDb, seedTenant, ensureRoleProbe } from "../db/test-db";
import { registry } from "../registry";
import { defineProcess } from "../process/define";
import { runProcess } from "../process/run";
import { ProcessError } from "../process/errors";
import type { Caller } from "../process/context";

const probe = defineProcess({
  id: "test.probe.create",
  module: "test",
  kind: "create",
  description: "crea un probe",
  input: z.object({ name: z.string().min(1), fail: z.boolean().optional() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [r] = await ctx.tx`insert into kernel.role_probe(company_id, secret) values (${ctx.companyId}, ${input.name}) returning id`;
    await ctx.emit("test.probe.created", { id: r!.id });
    if (input.fail) throw new Error("boom");
    return { id: r!.id as string };
  },
});

// Audit rows are append-only, so this suite never deletes them: every run seeds its own tenant and
// every assertion is scoped to its company or chain.
describe("run-process", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let deps: { sql: ReturnType<typeof testDb>; registry: typeof registry };
  let companyId: string;
  let adminRole: string;
  let adminUserId: string;
  let otherUserId: string;
  let adminClaims: JwtClaims;
  let cashierClaims: JwtClaims;
  const callerWith = (claims: JwtClaims): Caller => ({ claims, origin: "ui" });

  /** Service-role grant of `processId` to `roleId` in the seeded company. */
  const grant = (roleId: string, processId: string) =>
    sql`insert into kernel.process_permissions(company_id, role_id, process_id)
        values (${companyId}, ${roleId}, ${processId}) on conflict (company_id, role_id, process_id) do nothing`;

  /** Service-role step-up verification of `userId` at `at`; returns its token. */
  const insertVerification = async (userId: string, verifiedCompanyId: string, at: Date) => {
    const token = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, verified_at, token)
              values (${userId}, ${verifiedCompanyId}, ${at}, ${token})`;
    return token;
  };

  beforeAll(async () => {
    sql = testDb();
    await ensureRoleProbe(sql);
    // Test-only table: the probe handler inserts as the authenticated caller.
    await sql`grant insert on kernel.role_probe to authenticated`;
    seed = await seedTenant(sql, { companies: 1, users: [{ name: "cashier", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    adminRole = seed.companies[0]!.adminRoleId;
    adminUserId = seed.users.both;
    otherUserId = seed.users.onlyA;
    adminClaims = seed.claimsFor(adminUserId, companyId);
    cashierClaims = seed.claimsFor(seed.users.cashier!, companyId);
    deps = { sql, registry };
    registry.registerProcess(probe);
  });
  afterAll(async () => {
    await sql`delete from kernel.process_idempotency where company_id = ${companyId}`;
    await sql`delete from kernel.step_up_verifications where company_id = ${companyId}`;
    await sql`delete from kernel.sensitive_processes where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await sql`delete from kernel.role_probe where company_id = ${companyId}`;
    await seed.cleanup();
    await sql.end();
  });

  it("forbidden when no role permits the process", async () => {
    await expect(runProcess(deps, callerWith(cashierClaims), "test.probe.create", { name: "a" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("unknown process is not_found and a refused entitlement is not_entitled before the permission check", async () => {
    await expect(runProcess(deps, callerWith(adminClaims), "test.probe.nope", {})).rejects.toMatchObject({ code: "not_found" });
    const keys: string[] = [];
    const entitled = async (_sql: unknown, _companyId: unknown, key: string) => {
      keys.push(key);
      return !key.startsWith("process:");
    };
    // The cashier holds no permission, so a forbidden would surface if entitlements ran second.
    await expect(
      runProcess({ ...deps, entitled }, callerWith(cashierClaims), "test.probe.create", { name: "e" }),
    ).rejects.toMatchObject({ code: "not_entitled" });
    expect(keys).toEqual(["process:test.probe.create"]);
  });

  it("invalid input is rejected before the handler runs", async () => {
    await grant(adminRole, "test.probe.create");
    const error = await runProcess(deps, callerWith(adminClaims), "test.probe.create", { name: "" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect((error as { details: unknown[] }).details[0]).toMatchObject({ path: ["name"] });
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from kernel.role_probe where company_id = ${companyId}`;
    expect(row!.n).toBe(0);
  });

  it("success writes the row, one audit row with origin ui and one outbox row sharing chain_id", async () => {
    const out = await runProcess(deps, { claims: adminClaims, origin: "ui" }, "test.probe.create", { name: "ok" });
    const [probeRow] = await sql`select secret from kernel.role_probe where id = ${out.id}`;
    expect(probeRow!.secret).toBe("ok");
    const audits = await sql`select * from kernel.audit_log where process_id = 'test.probe.create' and row_id = ${out.id}`;
    const outbox = await sql`select * from kernel.outbox where event = 'test.probe.created' and payload->>'id' = ${out.id}`;
    expect(audits).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    const [a] = audits;
    expect(a!.origin).toBe("ui");
    expect(a!.action).toBe("insert");
    expect(a!.company_id).toBe(companyId);
    expect(a!.actor_user_id).toBe(adminUserId);
    expect(a!.input).toEqual({ name: "ok" });
    expect(outbox[0]!.chain_id).toBe(a!.chain_id);
  });

  it("runProcess rolls back audit and outbox on handler error", async () => {
    const chainId = randomUUID();
    const error = await runProcess(deps, { ...callerWith(adminClaims), chainId }, "test.probe.create", { name: "x", fail: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "handler_failed", cause: { message: "boom" } });
    const count = async (rows: Promise<{ n: number }[]>) => (await rows)[0]!.n;
    expect(await count(sql`select count(*)::int as n from kernel.role_probe where company_id = ${companyId} and secret = 'x'`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from kernel.audit_log where company_id = ${companyId} and input->>'name' = 'x'`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from kernel.audit_log where chain_id = ${chainId}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from kernel.outbox where chain_id = ${chainId}`)).toBe(0);
  });

  it("a ProcessError thrown by a handler keeps its code and rolls back", async () => {
    const refusing = defineProcess({
      ...probe,
      id: "test.probe.refuse",
      handler: async (ctx, input) => {
        await ctx.tx`insert into kernel.role_probe(company_id, secret) values (${ctx.companyId}, ${input.name})`;
        await ctx.emit("test.probe.created", { name: input.name });
        throw new ProcessError("invalid_input", "refused by the handler", { details: ["Dato inválido"] });
      },
    });
    registry.registerProcess(refusing);
    await grant(adminRole, refusing.id);
    const chainId = randomUUID();
    const error = await runProcess(deps, { ...callerWith(adminClaims), chainId }, refusing.id, { name: "refused" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProcessError);
    expect(error).toMatchObject({ code: "invalid_input", details: ["Dato inválido"] });
    const count = async (rows: Promise<{ n: number }[]>) => (await rows)[0]!.n;
    expect(await count(sql`select count(*)::int as n from kernel.role_probe where company_id = ${companyId} and secret = 'refused'`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from kernel.audit_log where chain_id = ${chainId}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from kernel.outbox where chain_id = ${chainId}`)).toBe(0);
  });

  it("step-up: sensitive process requires a fresh verification by the same user", async () => {
    await sql`insert into kernel.sensitive_processes values (${companyId}, 'test.probe.create', 'self_2fa')`;
    await expect(runProcess(deps, callerWith(adminClaims), "test.probe.create", { name: "s" })).rejects.toMatchObject({
      code: "step_up_required",
    });
    const token = await insertVerification(adminUserId, companyId, new Date());
    await expect(
      runProcess(deps, { ...callerWith(adminClaims), stepUpToken: token }, "test.probe.create", { name: "s" }),
    ).resolves.toBeDefined();
    // The verification is consumed by the run that used it.
    const [verification] = await sql`select consumed_at from kernel.step_up_verifications where token = ${token}`;
    expect(verification!.consumed_at).not.toBeNull();
    await expect(
      runProcess(deps, { ...callerWith(adminClaims), stepUpToken: token }, "test.probe.create", { name: "s2" }),
    ).rejects.toMatchObject({ code: "step_up_required" });
    // A process declared step-up needs it even without a sensitive_processes row (admins only raise).
    const declared = defineProcess({ ...probe, id: "test.probe.declared", sensitivity: "step-up" });
    registry.registerProcess(declared);
    await grant(adminRole, declared.id);
    await expect(runProcess(deps, callerWith(adminClaims), declared.id, { name: "d" })).rejects.toMatchObject({
      code: "step_up_required",
    });
  });

  it("step-up: foreign or stale verification rejected", async () => {
    const foreign = await insertVerification(otherUserId, companyId, new Date());
    await expect(
      runProcess(deps, { ...callerWith(adminClaims), stepUpToken: foreign }, "test.probe.create", { name: "f" }),
    ).rejects.toMatchObject({ code: "step_up_required" });
    const stale = await insertVerification(adminUserId, companyId, new Date(Date.now() - 6 * 60_000));
    await expect(
      runProcess(deps, { ...callerWith(adminClaims), stepUpToken: stale }, "test.probe.create", { name: "f" }),
    ).rejects.toMatchObject({ code: "step_up_required" });
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from kernel.role_probe where company_id = ${companyId} and secret = 'f'`;
    expect(row!.n).toBe(0);
  });

  it("a handler failure on a sensitive process leaves the verification unconsumed", async () => {
    const token = await insertVerification(adminUserId, companyId, new Date());
    await expect(
      runProcess(deps, { ...callerWith(adminClaims), stepUpToken: token }, "test.probe.create", { name: "u", fail: true }),
    ).rejects.toMatchObject({ code: "handler_failed" });
    const [verification] = await sql`select consumed_at from kernel.step_up_verifications where token = ${token}`;
    expect(verification!.consumed_at).toBeNull();
    await expect(
      runProcess(deps, { ...callerWith(adminClaims), stepUpToken: token }, "test.probe.create", { name: "u" }),
    ).resolves.toBeDefined();
  });

  it("each denial writes exactly one committed audit row with action denied", async () => {
    const refuse = async () => false;
    const cases = [
      { code: "not_entitled", run: (chainId: string) => runProcess({ ...deps, entitled: refuse }, { claims: adminClaims, origin: "agent", chainId }, "test.probe.create", { name: "n" }) },
      { code: "forbidden", run: (chainId: string) => runProcess(deps, { claims: cashierClaims, origin: "agent", chainId }, "test.probe.create", { name: "n" }) },
      // test.probe.create is sensitive since the step-up tests; no token is given.
      { code: "step_up_required", run: (chainId: string) => runProcess(deps, { claims: adminClaims, origin: "agent", chainId }, "test.probe.create", { name: "n" }) },
    ];
    for (const { code, run } of cases) {
      const chainId = randomUUID();
      await expect(run(chainId)).rejects.toMatchObject({ code });
      const rows = await sql`select * from kernel.audit_log where chain_id = ${chainId}`;
      expect(rows, code).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "denied",
        origin: "agent",
        process_id: "test.probe.create",
        entity: "test.probe",
        company_id: companyId,
        input: { code, process_id: "test.probe.create" },
      });
    }
  });

  it("ctx.audit cannot override the caller's identity fields", async () => {
    const audited = defineProcess({
      id: "test.probe.audited",
      module: "test",
      kind: "update",
      description: "audita un evento",
      input: z.object({}),
      output: z.object({}),
      handler: async (ctx) => {
        await ctx.audit({ entity: "test.extra", origin: "db", actorUserId: otherUserId, companyId: randomUUID() });
        return {};
      },
    });
    registry.registerProcess(audited);
    await grant(adminRole, audited.id);
    const chainId = randomUUID();
    await runProcess(deps, { claims: adminClaims, origin: "api", chainId }, audited.id, {});
    const [extra] = await sql`select * from kernel.audit_log where chain_id = ${chainId} and entity = 'test.extra'`;
    expect(extra).toMatchObject({ origin: "api", actor_user_id: adminUserId, company_id: companyId, action: "update" });
  });

  it("idempotency key replays the stored result without re-running", async () => {
    const p = defineProcess({ ...probe, id: "test.probe.idem", idempotencyKey: (i) => i.name });
    registry.registerProcess(p);
    await grant(adminRole, p.id);
    const a = await runProcess(deps, callerWith(adminClaims), p.id, { name: "same" });
    const b = await runProcess(deps, callerWith(adminClaims), p.id, { name: "same" });
    expect(b).toEqual(a);
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from kernel.role_probe where company_id = ${companyId} and secret = 'same'`;
    expect(row!.n).toBe(1);
  });

  it("consult-kind processes are audited with action consult", async () => {
    const list = defineProcess({
      id: "test.probe.list",
      module: "test",
      kind: "consult",
      description: "lista los probes",
      input: z.object({}),
      output: z.object({ rows: z.array(z.object({ id: z.string(), secret: z.string().nullable() })) }),
      handler: async (ctx) => {
        const rows = await ctx.tx<{ id: string; secret: string | null }[]>`select id, secret from kernel.v_role_probe order by id`;
        return { rows: [...rows] };
      },
    });
    registry.registerProcess(list);
    await grant(adminRole, list.id);
    const chainId = randomUUID();
    const out = await runProcess<typeof list.output>(deps, { claims: adminClaims, origin: "agent", chainId }, list.id, {});
    expect(out.rows.map((r) => r.secret).sort()).toEqual(["ok", "s", "same", "u"]);
    const audits = await sql`select * from kernel.audit_log where chain_id = ${chainId}`;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "consult",
      origin: "agent",
      process_id: "test.probe.list",
      entity: "test.probe",
      row_id: null,
      company_id: companyId,
      actor_user_id: adminUserId,
    });
  });

  it("process security tables: only the admin writes them and a user reads and consumes only their own verifications", async () => {
    const cashier = seed.users.cashier!;
    const asCashier = <T,>(fn: (tx: Tx) => Promise<T>) => withClaims(sql, cashierClaims, fn);
    await expect(
      asCashier((tx) => tx`insert into kernel.process_permissions(company_id, role_id, process_id)
        values (${companyId}, ${seed.companies[0]!.memberRoleId}, 'test.probe.create')`),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asCashier((tx) => tx`insert into kernel.sensitive_processes(company_id, process_id, mode) values (${companyId}, 'test.probe.list', 'self_2fa')`),
    ).rejects.toThrow(/row-level security/);
    // Verifications are recorded only by the service role after the TOTP check: a user cannot mint
    // one, not even for themselves.
    for (const userId of [cashier, adminUserId]) {
      await expect(
        asCashier((tx) => tx`insert into kernel.step_up_verifications(user_id, company_id, token) values (${userId}, ${companyId}, ${randomUUID()})`),
      ).rejects.toThrow(/permission denied/);
    }
    // The admin grants the member role a process, and the member can then run it.
    await withClaims(sql, adminClaims, (tx) => tx`insert into kernel.process_permissions(company_id, role_id, process_id)
      values (${companyId}, ${seed.companies[0]!.memberRoleId}, 'test.probe.list')`);
    await expect(runProcess(deps, callerWith(cashierClaims), "test.probe.list", {})).resolves.toMatchObject({ rows: expect.any(Array) });

    const mine = await insertVerification(cashier, companyId, new Date());
    const visible = await asCashier((tx) => tx`select token from kernel.step_up_verifications`);
    expect(visible.map((r) => r.token)).toEqual([mine]);
    await expect(
      asCashier((tx) => tx`update kernel.step_up_verifications set verified_at = now() where token = ${mine}`),
    ).rejects.toThrow(/permission denied/);
    const consumed = await asCashier((tx) => tx`update kernel.step_up_verifications set consumed_at = now() where token = ${mine} returning id`);
    expect(consumed).toHaveLength(1);
    const reopened = await asCashier((tx) => tx`update kernel.step_up_verifications set consumed_at = null where token = ${mine} returning id`);
    expect(reopened).toHaveLength(0);
  });
});
