import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, withClaims, type JwtClaims } from "../../db/client";
import { DbAuthAdmin } from "../../db/test-auth-admin";
import { seedTenant, testDb } from "../../db/test-db";
import { Registry } from "../../registry";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { runProcess } from "../../process/run";
import { ProcessError } from "../../process/errors";
import type { Caller } from "../../process/context";
import { setAuthAdmin } from "../../admin/auth-admin";
import { syncRegistry } from "../../admin/sync";

// Two-step verification opt-out (design §22.19) and migration 0028_kernel_mfa_exempt (rule 34). A user turns off their own
// second step with kernel.user.mfa.disable (self-service, step-up), unless they hold the system admin role without an
// exemption; the admin removes a member's factor and exempts a member from the admin role's requirement with
// kernel.admin.user.mfa.set (step-up). The factors go through the AuthAdmin adapter (here the database double, which
// deletes the rows of auth.mfa_factors); the exemption is kernel.memberships.mfa_exempt, which the access-token hook honours.

const ROLE_COPY = "Tu rol exige la verificación en dos pasos; pídele a un administrador que te exima";

describe("the user's second step", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let auth: DbAuthAdmin;
  let companyId: string;
  /** `both`: the company admin who administers; `boss`: a second admin; `clerk` and `idle`: members. */
  let admin: Caller;
  let boss: Caller;
  let clerk: Caller;
  let idle: Caller;

  const caller = (claims: JwtClaims): Caller => ({ claims, origin: "ui" });
  const stepUp = async (who: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${who.claims.sub}, ${companyId}, ${stepUpToken})`;
    return { ...who, stepUpToken };
  };
  const disable = async <T = unknown>(who: Caller, options: { dryRun?: boolean } = {}): Promise<T> =>
    runProcess({ sql, registry }, await stepUp(who), "kernel.user.mfa.disable", {}, options);
  const setMfa = async <T = unknown>(input: Record<string, unknown>, who: Caller = admin, options: { dryRun?: boolean } = {}): Promise<T> =>
    runProcess({ sql, registry }, await stepUp(who), "kernel.admin.user.mfa.set", input, options);

  /** Enrols a verified TOTP factor for the user, straight into the auth schema. */
  const enrol = (userId: string) => sql`
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
    values (gen_random_uuid(), ${userId}, ${`totp-${randomUUID().slice(0, 8)}`}, 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')`;
  const factors = async (userId: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from auth.mfa_factors where user_id = ${userId}`)[0]!.n;
  const exempt = (userId: string, value: boolean) => sql`update kernel.memberships set mfa_exempt = ${value} where user_id = ${userId} and company_id = ${companyId}`;
  const details = (error: unknown) => (error instanceof ProcessError && Array.isArray(error.details) ? error.details.map(String) : []);
  const lastRun = async (processId: string, actor: string) =>
    (
      await sql<{ entity: string; action: string; input: Record<string, unknown> | null; actor_user_id: string }[]>`
        select entity, action, input, actor_user_id from kernel.audit_log
        where company_id = ${companyId} and process_id = ${processId} and actor_user_id = ${actor} and entity <> 'kernel.memberships'
        order by occurred_at desc, id desc limit 1`
    )[0];

  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [kernelModule]);
    seed = await seedTenant(sql, {
      companies: 1,
      entitlements: [],
      users: [
        { name: "clerk", companies: [0], role: "member" },
        { name: "idle", companies: [0], role: "member" },
        { name: "boss", companies: [0], role: "admin" },
      ],
    });
    companyId = seed.companies[0]!.id;
    await syncRegistry(sql, registry);
    await sql`select kernel.seed_company_defaults(${companyId})`;
    admin = caller(seed.claimsFor(seed.users.both, companyId));
    boss = caller(seed.claimsFor(seed.users.boss!, companyId));
    clerk = caller(seed.claimsFor(seed.users.clerk!, companyId));
    idle = caller(seed.claimsFor(seed.users.idle!, companyId));
    auth = new DbAuthAdmin(sql);
    setAuthAdmin(auth);
  });
  afterAll(async () => {
    setAuthAdmin(undefined);
    await auth.cleanup();
    await seed.cleanup();
    await sql.end();
  });
  beforeEach(async () => {
    auth.deletedFactorsOf.length = 0;
    await sql`delete from auth.mfa_factors where user_id = any(${[seed.users.both, seed.users.boss!, seed.users.clerk!, seed.users.idle!]}::uuid[])`;
    await sql`update kernel.memberships set mfa_exempt = false where company_id = ${companyId} and mfa_exempt`;
  });

  describe("kernel.user.mfa.disable", () => {
    it("is a self-service step-up update of the users feature", () => {
      expect(registry.process("kernel.user.mfa.disable")).toMatchObject({ module: "kernel", kind: "update", feature: "kernel.users", permission: "none", sensitivity: "step-up" });
    });

    it("needs a fresh step-up", async () => {
      await enrol(seed.users.clerk!);
      await expect(runProcess({ sql, registry }, clerk, "kernel.user.mfa.disable", {})).rejects.toMatchObject({ code: "step_up_required" });
      expect(auth.deletedFactorsOf).toEqual([]);
      expect(await factors(seed.users.clerk!)).toBe(1);
    });

    it("removes the factors of a member whose roles do not require it, and audits the run on their name", async () => {
      await enrol(seed.users.clerk!);
      await expect(disable(clerk)).resolves.toEqual({ removed: 1 });
      expect(auth.deletedFactorsOf).toEqual([seed.users.clerk]);
      expect(await factors(seed.users.clerk!)).toBe(0);
      expect(await lastRun("kernel.user.mfa.disable", seed.users.clerk!)).toMatchObject({ action: "update", input: {}, actor_user_id: seed.users.clerk });
    });

    it("answers 0 for a member without a factor", async () => {
      await expect(disable(idle)).resolves.toEqual({ removed: 0 });
      expect(auth.deletedFactorsOf).toEqual([seed.users.idle]);
    });

    it("refuses a system admin without an exemption, before reaching the identity provider", async () => {
      await enrol(seed.users.boss!);
      const error = await disable(boss).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(details(error)).toEqual([ROLE_COPY]);
      expect(auth.deletedFactorsOf).toEqual([]);
      expect(await factors(seed.users.boss!)).toBe(1);
    });

    it("lets an exempt system admin turn it off", async () => {
      await enrol(seed.users.boss!);
      await exempt(seed.users.boss!, true);
      await expect(disable(boss)).resolves.toEqual({ removed: 1 });
      expect(auth.deletedFactorsOf).toEqual([seed.users.boss]);
      expect(await factors(seed.users.boss!)).toBe(0);
    });

    it("removes nothing in a dry run", async () => {
      await enrol(seed.users.clerk!);
      await expect(disable(clerk, { dryRun: true })).resolves.toEqual({ removed: 0 });
      expect(auth.deletedFactorsOf).toEqual([]);
      expect(await factors(seed.users.clerk!)).toBe(1);
    });
  });

  describe("kernel.admin.user.mfa.set", () => {
    const membershipOf = async (userId: string) =>
      (await sql<{ id: string }[]>`select id from kernel.memberships where user_id = ${userId} and company_id = ${companyId}`)[0]!.id;
    /** What the admin reads of a member through kernel.v_memberships, as the admin. */
    const seen = (userId: string) =>
      withClaims(sql, admin.claims, async (tx) => (await tx<{ mfa_exempt: boolean }[]>`select mfa_exempt from kernel.v_memberships where user_id = ${userId}`)[0]);

    it("is a step-up update of the admin feature that the system admin role holds", async () => {
      expect(registry.process("kernel.admin.user.mfa.set")).toMatchObject({ module: "kernel", kind: "update", feature: "kernel.admin", sensitivity: "step-up" });
      const [granted] = await sql`
        select 1 from kernel.process_permissions where company_id = ${companyId} and role_id = ${seed.companies[0]!.adminRoleId} and process_id = 'kernel.admin.user.mfa.set'`;
      expect(granted).toBeDefined();
    });

    it("needs a fresh step-up and refuses a member who is not the admin", async () => {
      await expect(runProcess({ sql, registry }, admin, "kernel.admin.user.mfa.set", { userId: seed.users.clerk!, reset: true })).rejects.toMatchObject({ code: "step_up_required" });
      await expect(setMfa({ userId: seed.users.idle!, reset: true }, clerk)).rejects.toMatchObject({ code: "forbidden" });
      expect(auth.deletedFactorsOf).toEqual([]);
    });

    it("refuses a user of another company and an input that changes nothing", async () => {
      const stranger = await seedTenant(sql, { companies: 1, entitlements: [] });
      try {
        await enrol(stranger.users.both);
        const error = await setMfa({ userId: stranger.users.both, reset: true }).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "invalid_input" });
        expect(details(error)).toContain("El usuario no pertenece a la empresa");
        expect(auth.deletedFactorsOf).toEqual([]);
        expect(await factors(stranger.users.both)).toBe(1);
      } finally {
        await stranger.cleanup();
      }
      const nothing = await setMfa({ userId: seed.users.clerk! }).catch((e: unknown) => e);
      expect(nothing).toMatchObject({ code: "invalid_input" });
      expect(JSON.stringify(nothing instanceof ProcessError ? nothing.details : null)).toContain("Indica qué cambiar");
    });

    it("exempts a member: v_memberships shows it and the membership's audit row records false → true", async () => {
      await expect(setMfa({ userId: seed.users.boss!, exempt: true })).resolves.toEqual({ userId: seed.users.boss, removed: 0, exempt: true });
      expect(await seen(seed.users.boss!)).toEqual({ mfa_exempt: true });
      const membershipId = await membershipOf(seed.users.boss!);
      const [row] = await sql<{ diff: Record<string, { old: unknown; new: unknown }>; actor_user_id: string; process_id: string }[]>`
        select diff, actor_user_id, process_id from kernel.audit_log
        where entity = 'kernel.memberships' and row_id = ${membershipId} and diff ? 'mfa_exempt' order by occurred_at desc, id desc limit 1`;
      expect(row).toMatchObject({ diff: { mfa_exempt: { old: false, new: true } }, actor_user_id: seed.users.both, process_id: "kernel.admin.user.mfa.set" });
      expect(auth.deletedFactorsOf).toEqual([]);

      await expect(setMfa({ userId: seed.users.boss!, exempt: false })).resolves.toMatchObject({ exempt: false });
      expect(await seen(seed.users.boss!)).toEqual({ mfa_exempt: false });
    });

    it("resets a member's factor through the adapter and audits the input with the target", async () => {
      await enrol(seed.users.clerk!);
      await expect(setMfa({ userId: seed.users.clerk!, reset: true })).resolves.toEqual({ userId: seed.users.clerk, removed: 1, exempt: false });
      expect(auth.deletedFactorsOf).toEqual([seed.users.clerk]);
      expect(await factors(seed.users.clerk!)).toBe(0);
      expect(await lastRun("kernel.admin.user.mfa.set", seed.users.both)).toMatchObject({ action: "update", input: { userId: seed.users.clerk, reset: true } });
    });

    it("lets the admin exempt and reset themselves", async () => {
      await enrol(seed.users.both);
      await expect(setMfa({ userId: seed.users.both, exempt: true, reset: true })).resolves.toEqual({ userId: seed.users.both, removed: 1, exempt: true });
      expect(await seen(seed.users.both)).toEqual({ mfa_exempt: true });
      expect(await factors(seed.users.both)).toBe(0);
    });

    it("changes nothing in a dry run", async () => {
      await enrol(seed.users.clerk!);
      await expect(setMfa({ userId: seed.users.clerk!, reset: true, exempt: true }, admin, { dryRun: true })).resolves.toEqual({ userId: seed.users.clerk, removed: 0, exempt: true });
      expect(auth.deletedFactorsOf).toEqual([]);
      expect(await factors(seed.users.clerk!)).toBe(1);
      const [row] = await sql<{ mfa_exempt: boolean }[]>`select mfa_exempt from kernel.memberships where user_id = ${seed.users.clerk!} and company_id = ${companyId}`;
      expect(row!.mfa_exempt).toBe(false);
    });
  });

  describe("the access token hook", () => {
    // Called by Auth as supabase_auth_admin, the only role granted it. That login exists on the CLI and compose stacks with
    // the service user's password (a hosted project keeps it to itself): elsewhere the service connection calls it.
    const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    const localDb = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
    const hook = async (userId: string) => {
      const event = { user_id: userId, claims: { sub: userId, app_metadata: { active_company_id: companyId } } };
      if (!localDb) {
        const [row] = await sql<{ hook: { claims: Record<string, unknown> } }[]>`select kernel.custom_access_token_hook(${sql.json(event)}) as hook`;
        return row!.hook.claims;
      }
      url.username = "supabase_auth_admin";
      const authDb = createDb(url.toString());
      try {
        const [row] = await authDb<{ hook: { claims: Record<string, unknown> } }[]>`select kernel.custom_access_token_hook(${authDb.json(event)}) as hook`;
        return row!.hook.claims;
      } finally {
        await authDb.end();
      }
    };

    it("requires the second step of an admin unless the membership is exempt", async () => {
      expect(await hook(seed.users.boss!)).toMatchObject({ requires_mfa: true, active_company_id: companyId });
      await exempt(seed.users.boss!, true);
      expect(await hook(seed.users.boss!)).toMatchObject({ requires_mfa: false, active_company_id: companyId });
      await exempt(seed.users.boss!, false);
      expect(await hook(seed.users.boss!)).toMatchObject({ requires_mfa: true });
      // A member's role never required it, exempt or not.
      expect(await hook(seed.users.clerk!)).toMatchObject({ requires_mfa: false });
    });
  });
});
