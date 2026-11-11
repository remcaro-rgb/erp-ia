import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import type { JwtClaims } from "../../db/client";
import { ensureRoleProbe, seedTenant, testDb, type SeededTenant } from "../../db/test-db";
import { Registry } from "../../registry";
import { defineProcess } from "../define";
import { runProcess } from "../run";
import type { Caller } from "../context";

// runProcess(..., { dryRun: true }) (Task 13b): the whole pipeline runs, the handler included, in a transaction
// that is always rolled back. No record, audit, outbox or idempotency row survives; refusals keep their codes and a
// denial is still audited.

const ids = { create: "dryrun.probe.create", refuse: "dryrun.probe.refuse", keyed: "dryrun.probe.keyed", sensitive: "dryrun.probe.sensitive" };
/** What each run's handler saw in ctx.dryRun, by probe name. */
const seenDryRun = new Map<string, boolean>();

const insertProbe = (name: string) =>
  defineProcess({
    id: name,
    module: "dryrun",
    kind: "create",
    description: "crea un probe",
    input: z.object({ name: z.string().min(1) }),
    output: z.object({ id: z.string(), name: z.string() }),
    idempotencyKey: name === ids.keyed ? (input) => input.name : undefined,
    sensitivity: name === ids.sensitive ? "step-up" : undefined,
    handler: async (ctx, input) => {
      seenDryRun.set(input.name, ctx.dryRun);
      const [row] = await ctx.tx<{ id: string }[]>`insert into kernel.role_probe(company_id, secret) values (${ctx.companyId}, ${input.name}) returning id`;
      await ctx.emit("dryrun.probe.created", { id: row!.id });
      await ctx.audit({ action: "update", input: { note: "extra entry" } });
      return { id: row!.id, name: input.name };
    },
  });

/** Minor 2 (final review): a deferred effect that throws after the commit. */
const afterThrows = defineProcess({
  id: "dryrun.probe.after_throws",
  module: "dryrun",
  kind: "create",
  description: "efecto posterior que falla",
  input: z.object({ name: z.string() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`insert into kernel.role_probe(company_id, secret) values (${ctx.companyId}, ${input.name}) returning id`;
    ctx.afterCommit?.(async () => {
      throw new Error("post-commit boom");
    });
    ctx.afterCommit?.(async () => {
      afterRan.push(input.name);
    });
    return { id: row!.id };
  },
});
const afterRan: string[] = [];

const refuse = defineProcess({
  id: ids.refuse,
  module: "dryrun",
  kind: "create",
  description: "rechaza",
  input: z.object({ name: z.string() }),
  output: z.object({}),
  handler: async (ctx, input) => {
    await ctx.tx`insert into kernel.role_probe(company_id, secret) values (${ctx.companyId}, ${input.name})`;
    const { ProcessError } = await import("../errors");
    throw new ProcessError("invalid_input", "rechazado", { details: ["El nombre ya existe"] });
  },
});

describe("runProcess dry run", () => {
  const sql = testDb();
  const registry = new Registry();
  let seed: SeededTenant;
  let companyId: string;
  let admin: JwtClaims;
  let member: JwtClaims;
  const as = (claims: JwtClaims, extra: Partial<Caller> = {}): Caller => ({ claims, origin: "ui", ...extra });
  const count = async (rows: Promise<{ n: number }[]>) => (await rows)[0]!.n;
  const probes = (name: string) => count(sql`select count(*)::int as n from kernel.role_probe where company_id = ${companyId} and secret = ${name}`);
  const audits = (chainId: string) => count(sql`select count(*)::int as n from kernel.audit_log where chain_id = ${chainId}`);
  const outbox = (chainId: string) => count(sql`select count(*)::int as n from kernel.outbox where chain_id = ${chainId}`);

  beforeAll(async () => {
    await ensureRoleProbe(sql);
    await sql`grant insert on kernel.role_probe to authenticated`;
    seed = await seedTenant(sql, { companies: 1, users: [{ name: "member", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    admin = seed.claimsFor(seed.users.both, companyId);
    member = seed.claimsFor(seed.users.member!, companyId);
    for (const p of [insertProbe(ids.create), insertProbe(ids.keyed), insertProbe(ids.sensitive), refuse, afterThrows]) {
      registry.registerProcess(p);
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.adminRoleId}, ${p.id})`;
    }
  });

  afterAll(async () => {
    await sql`delete from kernel.process_idempotency where company_id = ${companyId}`;
    await sql`delete from kernel.step_up_verifications where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await sql`delete from kernel.role_probe where company_id = ${companyId}`;
    await seed.cleanup();
    await sql.end();
  });

  const deps = () => ({ sql, registry, entitled: async () => true });

  it("returns the handler output and leaves no row, audit or outbox entry", async () => {
    const chainId = randomUUID();
    const out = await runProcess(deps(), as(admin, { chainId }), ids.create, { name: "dry-1" }, { dryRun: true });
    expect(out).toMatchObject({ name: "dry-1", id: expect.any(String) });
    expect(await probes("dry-1")).toBe(0);
    expect(await audits(chainId)).toBe(0);
    expect(await outbox(chainId)).toBe(0);
    // The handler knows it is a dry run (to skip effects outside the database); a real run says so too.
    expect(seenDryRun.get("dry-1")).toBe(true);
    await runProcess(deps(), as(admin), ids.create, { name: "real-1" });
    expect(seenDryRun.get("real-1")).toBe(false);
  });

  it("tells the events the run would emit (onDryRunEvents, plan 2B Task 25), only its own, and leaves none in the outbox", async () => {
    const chainId = randomUUID();
    // A committed run earlier on the same chain: its event is not the dry run's.
    await runProcess(deps(), as(admin, { chainId }), ids.create, { name: "ev-real" });
    let events: { event: string; payload: unknown }[] | undefined;
    await runProcess(deps(), as(admin, { chainId }), ids.create, { name: "ev-dry" }, { dryRun: true, onDryRunEvents: (e) => (events = e) });
    expect(events).toEqual([{ event: "dryrun.probe.created", payload: { id: expect.any(String) } }]);
    expect(await outbox(chainId)).toBe(1);
  });

  it("a caller-given idempotency key replays the first run instead of running again", async () => {
    const first = await runProcess(deps(), as(admin), ids.create, { name: "keyed-1" }, { idempotencyKey: "import:x:0" });
    const again = await runProcess(deps(), as(admin), ids.create, { name: "keyed-1" }, { idempotencyKey: "import:x:0" });
    expect(again).toEqual(first);
    expect(await probes("keyed-1")).toBe(1);
    // A dry run never records the key: the first real run with it still runs.
    await runProcess(deps(), as(admin), ids.create, { name: "keyed-2" }, { dryRun: true, idempotencyKey: "import:x:1" });
    await runProcess(deps(), as(admin), ids.create, { name: "keyed-2" }, { idempotencyKey: "import:x:1" });
    expect(await probes("keyed-2")).toBe(1);
  });

  it("an invalid input is refused with invalid_input and its paths, as in a real run", async () => {
    const error = await runProcess(deps(), as(admin), ids.create, { name: "" }, { dryRun: true }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input", stage: "gate" });
    expect((error as { details: { path: string[] }[] }).details[0]!.path).toEqual(["name"]);
  });

  it("a handler refusal keeps its code and details and its writes are rolled back", async () => {
    const chainId = randomUUID();
    const error = await runProcess(deps(), as(admin, { chainId }), ids.refuse, { name: "dry-refused" }, { dryRun: true }).catch((e: unknown) => e);
    // Thrown by the handler, not by the pipeline's own checks.
    expect(error).toMatchObject({ code: "invalid_input", details: ["El nombre ya existe"], stage: "handler" });
    expect(await probes("dry-refused")).toBe(0);
    expect(await audits(chainId)).toBe(0);
  });

  it("a forbidden dry run (import preview, not the assistant's preflight) is refused and the denial is audited", async () => {
    const chainId = randomUUID();
    await expect(runProcess(deps(), as(member, { chainId }), ids.create, { name: "dry-member" }, { dryRun: true })).rejects.toMatchObject({ code: "forbidden", stage: "gate" });
    const [denied] = await sql`select action, process_id from kernel.audit_log where chain_id = ${chainId}`;
    expect(denied).toMatchObject({ action: "denied", process_id: ids.create });
  });

  it("writes no idempotency record, so the real run afterwards executes", async () => {
    const dry = await runProcess(deps(), as(admin), ids.keyed, { name: "dry-key" }, { dryRun: true });
    expect(await count(sql`select count(*)::int as n from kernel.process_idempotency where company_id = ${companyId} and key = 'dry-key'`)).toBe(0);
    const real = await runProcess(deps(), as(admin), ids.keyed, { name: "dry-key" });
    expect(real.id).not.toBe(dry.id);
    expect(await probes("dry-key")).toBe(1);
  });

  it("checks the step-up like a real run and leaves the verification unconsumed", async () => {
    await expect(runProcess(deps(), as(admin), ids.sensitive, { name: "dry-s" }, { dryRun: true })).rejects.toMatchObject({ code: "step_up_required" });
    const token = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${seed.users.both}, ${companyId}, ${token})`;
    await runProcess(deps(), as(admin, { stepUpToken: token }), ids.sensitive, { name: "dry-s" }, { dryRun: true });
    const [verification] = await sql`select consumed_at from kernel.step_up_verifications where token = ${token}`;
    expect(verification!.consumed_at).toBeNull();
    expect(await probes("dry-s")).toBe(0);
  });

  it("minor 2: a post-commit step that throws is logged; the caller gets the committed result and the later steps still run", async () => {
    const { vi } = await import("vitest");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const chainId = randomUUID();
      const out = await runProcess(deps(), as(admin, { chainId }), "dryrun.probe.after_throws", { name: "after-1" });
      expect(out).toMatchObject({ id: expect.any(String) });
      expect(await probes("after-1")).toBe(1);
      expect(afterRan).toContain("after-1");
      expect(errors.mock.calls.some((call) => String(call[0]).includes("dryrun.probe.after_throws"))).toBe(true);
      // Rule 16: the failure is audited on the run's chain, in a transaction of its own (the run's own entry stays).
      const failed = await sql<{ process_id: string; actor_user_id: string; origin: string; input: { code: string; message: string } }[]>`
        select process_id, actor_user_id, origin, input from kernel.audit_log where chain_id = ${chainId} and input ->> 'code' = 'post_commit_failed'`;
      expect(failed).toEqual([{ process_id: "dryrun.probe.after_throws", actor_user_id: seed.users.both, origin: "ui", input: { code: "post_commit_failed", message: "post-commit boom" } }]);
    } finally {
      errors.mockRestore();
    }
  });
});
