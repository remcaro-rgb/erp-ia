import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, withClaims, type JwtClaims } from "../../db/client";
import { DbAuthAdmin } from "../../db/test-auth-admin";
import { seedTenant, testDb } from "../../db/test-db";
import { Registry } from "../../registry";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { runProcess } from "../../process/run";
import { isMembershipInactive, ProcessError } from "../../process/errors";
import type { Caller } from "../../process/context";
import { setAuthAdmin } from "../../admin/auth-admin";
import { syncRegistry } from "../../admin/sync";

// Two-step verification opt-out (design §22.19) and migrations 0028_kernel_mfa_exempt and 0056_kernel_mfa_required_passwords (rule 34). A user turns off their own
// second step with kernel.user.mfa.disable (self-service, step-up), unless an administrator requires it of them (owner
// decision 2026-11-04: mandatory only when an admin sets it, an admin included); the admin removes a member's factor and
// requires or stops requiring it with
// kernel.admin.user.mfa.set (step-up). The factors go through the AuthAdmin adapter (here the database double, which
// deletes the rows of auth.mfa_factors); the requirement is kernel.memberships.mfa_required, which the access-token hook reads.

const ROLE_COPY = "Un administrador exige tu verificación en dos pasos; pídele que deje de exigirla";
const SHARED_COPY = "Ese usuario pertenece también a otra organización; su segundo paso no se cambia desde aquí";

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
  /** An open session of the user with its refresh token, straight into the auth schema (what a sign-in leaves). */
  const openSession = async (userId: string) => {
    const [session] = await sql<{ id: string }[]>`insert into auth.sessions (id, user_id, aal, created_at, updated_at) values (gen_random_uuid(), ${userId}, 'aal2', now(), now()) returning id`;
    await sql`insert into auth.refresh_tokens (token, user_id, revoked, session_id, created_at, updated_at) values (${randomUUID()}, ${userId}, false, ${session!.id}, now(), now())`;
  };
  const sessions = async (userId: string) =>
    (await sql<{ n: number }[]>`select ((select count(*) from auth.sessions where user_id = ${userId}) + (select count(*) from auth.refresh_tokens where user_id = ${userId}))::int as n`)[0]!.n;
  const factors = async (userId: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from auth.mfa_factors where user_id = ${userId}`)[0]!.n;
  const require = (userId: string, value: boolean) => sql`update kernel.memberships set mfa_required = ${value} where user_id = ${userId} and company_id = ${companyId}`;
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
    auth.signedOut.length = 0;
    await sql`delete from auth.sessions where user_id = any(${[seed.users.both, seed.users.boss!, seed.users.clerk!, seed.users.idle!]}::uuid[])`;
    await sql`delete from auth.mfa_factors where user_id = any(${[seed.users.both, seed.users.boss!, seed.users.clerk!, seed.users.idle!]}::uuid[])`;
    await sql`update kernel.memberships set mfa_required = false where company_id = ${companyId} and mfa_required`;
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

    it("removes the factors of a member whose roles do not require it, ends every session of theirs, and audits the run on their name", async () => {
      await enrol(seed.users.clerk!);
      await openSession(seed.users.clerk!);
      await openSession(seed.users.clerk!);
      await openSession(seed.users.idle!);
      await expect(disable(clerk)).resolves.toEqual({ removed: 1 });
      expect(auth.deletedFactorsOf).toEqual([seed.users.clerk]);
      expect(await factors(seed.users.clerk!)).toBe(0);
      // Owner decision 2026-10-30 (design §22.19): the other sessions end too; nobody else's.
      expect(auth.signedOut).toEqual([seed.users.clerk]);
      expect(await sessions(seed.users.clerk!)).toBe(0);
      expect(await sessions(seed.users.idle!)).toBe(2);
      expect(await lastRun("kernel.user.mfa.disable", seed.users.clerk!)).toMatchObject({ action: "update", input: {}, actor_user_id: seed.users.clerk });
    });

    it("answers 0 for a member without a factor, and then ends no session", async () => {
      await openSession(seed.users.idle!);
      await expect(disable(idle)).resolves.toEqual({ removed: 0 });
      expect(auth.deletedFactorsOf).toEqual([seed.users.idle]);
      expect(auth.signedOut).toEqual([]);
      expect(await sessions(seed.users.idle!)).toBe(2);
    });

    it("refuses a member whose second step an administrator requires, before reaching the identity provider", async () => {
      await enrol(seed.users.boss!);
      await require(seed.users.boss!, true);
      const error = await disable(boss).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(details(error)).toEqual([ROLE_COPY]);
      expect(auth.deletedFactorsOf).toEqual([]);
      expect(auth.signedOut).toEqual([]);
      expect(await factors(seed.users.boss!)).toBe(1);
    });

    it("lets a system admin turn it off: no role requires it by itself", async () => {
      await enrol(seed.users.boss!);
      await expect(disable(boss)).resolves.toEqual({ removed: 1 });
      expect(auth.deletedFactorsOf).toEqual([seed.users.boss]);
      expect(await factors(seed.users.boss!)).toBe(0);
    });

    it("refuses a member required in another company of the tenant while they stand in one where nothing requires it", async () => {
      // `dual` is a plain member of company A and the admin of company B, where the second step is required; the factor is the identity's.
      const tenant = await seedTenant(sql, { companies: 2, entitlements: [], users: [{ name: "dual", companies: [0, 1], role: "member" }] });
      try {
        const [a, b] = [tenant.companies[0]!, tenant.companies[1]!];
        const dual = tenant.users.dual!;
        await tenant.holdRoles(dual, b.id, [b.adminRoleId]);
        await sql`update kernel.memberships set mfa_required = true where user_id = ${dual} and company_id = ${b.id}`;
        await enrol(dual);
        const inA = async (options: { dryRun?: boolean } = {}) => {
          const stepUpToken = randomUUID();
          await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${dual}, ${a.id}, ${stepUpToken})`;
          return runProcess({ sql, registry }, { ...caller(tenant.claimsFor(dual, a.id)), stepUpToken }, "kernel.user.mfa.disable", {}, options);
        };
        const refused = await inA().catch((e: unknown) => e);
        expect(refused).toMatchObject({ code: "invalid_input" });
        expect(details(refused)).toEqual([ROLE_COPY]);
        expect(auth.deletedFactorsOf).toEqual([]);
        expect(await factors(dual)).toBe(1);

        // An inactive membership requires nothing.
        await sql`update kernel.memberships set is_active = false where user_id = ${dual} and company_id = ${b.id}`;
        await expect(inA({ dryRun: true })).resolves.toEqual({ removed: 0 });
        await sql`update kernel.memberships set is_active = true where user_id = ${dual} and company_id = ${b.id}`;
        await expect(inA()).rejects.toMatchObject({ code: "invalid_input" });

        // Not required in B any more: allowed from A.
        await sql`update kernel.memberships set mfa_required = false where user_id = ${dual} and company_id = ${b.id}`;
        await expect(inA()).resolves.toEqual({ removed: 1 });
        expect(auth.deletedFactorsOf).toEqual([dual]);
        expect(await factors(dual)).toBe(0);
      } finally {
        await tenant.cleanup();
      }
    });

    it("asks kernel.user_requires_mfa only about the caller: another user's answer is false, even for a member whose second step is required", async () => {
      const ask = (who: Caller, userId: string) =>
        withClaims(sql, who.claims, async (tx) => (await tx<{ required: boolean }[]>`select kernel.user_requires_mfa(${userId}) as required`)[0]!.required);
      // boss is required: true when boss asks, false when anyone else asks (a member, another admin, another tenant).
      await require(seed.users.boss!, true);
      expect(await ask(boss, seed.users.boss!)).toBe(true);
      expect(await ask(clerk, seed.users.boss!)).toBe(false);
      expect(await ask(admin, seed.users.boss!)).toBe(false);
      const stranger = await seedTenant(sql, { companies: 1, entitlements: [] });
      try {
        expect(await ask(caller(stranger.claimsFor(stranger.users.both, stranger.companies[0]!.id)), seed.users.boss!)).toBe(false);
      } finally {
        await stranger.cleanup();
      }
      // A connection without claims gets no answer either.
      const [service] = await sql<{ required: boolean }[]>`select kernel.user_requires_mfa(${seed.users.boss!}) as required`;
      expect(service!.required).toBe(false);
    });

    it("refuses a caller whose membership is inactive at the gate, even with a valid step-up", async () => {
      await enrol(seed.users.clerk!);
      await sql`update kernel.memberships set is_active = false where user_id = ${seed.users.clerk!} and company_id = ${companyId}`;
      try {
        const error = await disable(clerk).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "forbidden" });
        expect(isMembershipInactive(error)).toBe(true);
        expect(auth.deletedFactorsOf).toEqual([]);
        expect(await factors(seed.users.clerk!)).toBe(1);
      } finally {
        await sql`update kernel.memberships set is_active = true where user_id = ${seed.users.clerk!} and company_id = ${companyId}`;
      }
    });

    it("removes nothing and ends no session in a dry run", async () => {
      await enrol(seed.users.clerk!);
      await openSession(seed.users.clerk!);
      await expect(disable(clerk, { dryRun: true })).resolves.toEqual({ removed: 0 });
      expect(auth.deletedFactorsOf).toEqual([]);
      expect(auth.signedOut).toEqual([]);
      expect(await sessions(seed.users.clerk!)).toBe(2);
      expect(await factors(seed.users.clerk!)).toBe(1);
    });
  });

  describe("kernel.admin.user.mfa.set", () => {
    const membershipOf = async (userId: string) =>
      (await sql<{ id: string }[]>`select id from kernel.memberships where user_id = ${userId} and company_id = ${companyId}`)[0]!.id;
    /** What the admin reads of a member through kernel.v_memberships, as the admin. */
    const seen = (userId: string) =>
      withClaims(sql, admin.claims, async (tx) => (await tx<{ mfa_required: boolean }[]>`select mfa_required from kernel.v_memberships where user_id = ${userId}`)[0]);

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

    it("refuses to reset the factor of a member who also belongs to another organization, and still requires or releases their second step", async () => {
      // `shared` belongs to another tenant and is also a member of this company (data from before the one-tenant rule):
      // the factor is the identity's, so removing it here would strip the other organization's second step too.
      const other = await seedTenant(sql, { companies: 1, entitlements: [], users: [{ name: "shared", companies: [0] }] });
      const shared = other.users.shared!;
      try {
        const [membership] = await sql<{ id: string }[]>`insert into kernel.memberships (user_id, company_id) values (${shared}, ${companyId}) returning id`;
        await sql`insert into kernel.membership_roles (membership_id, role_id) values (${membership!.id}, ${seed.companies[0]!.memberRoleId})`;
        await enrol(shared);

        for (const input of [{ userId: shared, reset: true }, { userId: shared, reset: true, required: true }]) {
          const refused = await setMfa(input).catch((e: unknown) => e);
          expect(refused).toMatchObject({ code: "invalid_input" });
          expect(details(refused)).toEqual([SHARED_COPY]);
        }
        const dryRefused = await setMfa({ userId: shared, reset: true }, admin, { dryRun: true }).catch((e: unknown) => e);
        expect(dryRefused).toMatchObject({ code: "invalid_input" });
        expect(auth.deletedFactorsOf).toEqual([]);
        expect(auth.signedOut).toEqual([]);
        expect(await factors(shared)).toBe(1);
        expect(await seen(shared)).toEqual({ mfa_required: false });

        // The requirement is per membership (this company's only): allowed.
        await expect(setMfa({ userId: shared, required: true })).resolves.toEqual({ userId: shared, removed: 0, required: true });
        expect(await seen(shared)).toEqual({ mfa_required: true });
        await expect(setMfa({ userId: shared, required: false })).resolves.toMatchObject({ required: false });
        expect(auth.deletedFactorsOf).toEqual([]);
        expect(await factors(shared)).toBe(1);
      } finally {
        await sql`delete from auth.mfa_factors where user_id = ${shared}`;
        await sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = ${shared} and company_id = ${companyId})`;
        await sql`delete from kernel.memberships where user_id = ${shared} and company_id = ${companyId}`;
        await other.cleanup();
      }
    });

    it("requires a member's second step: v_memberships shows it and the membership's audit row records false → true", async () => {
      await expect(setMfa({ userId: seed.users.boss!, required: true })).resolves.toEqual({ userId: seed.users.boss, removed: 0, required: true });
      expect(await seen(seed.users.boss!)).toEqual({ mfa_required: true });
      const membershipId = await membershipOf(seed.users.boss!);
      const [row] = await sql<{ diff: Record<string, { old: unknown; new: unknown }>; actor_user_id: string; process_id: string }[]>`
        select diff, actor_user_id, process_id from kernel.audit_log
        where entity = 'kernel.memberships' and row_id = ${membershipId} and diff ? 'mfa_required' order by occurred_at desc, id desc limit 1`;
      expect(row).toMatchObject({ diff: { mfa_required: { old: false, new: true } }, actor_user_id: seed.users.both, process_id: "kernel.admin.user.mfa.set" });
      expect(auth.deletedFactorsOf).toEqual([]);
      expect(auth.signedOut).toEqual([]);

      await expect(setMfa({ userId: seed.users.boss!, required: false })).resolves.toMatchObject({ required: false });
      expect(await seen(seed.users.boss!)).toEqual({ mfa_required: false });
    });

    it("resets a member's factor through the adapter, ends the member's sessions (not the admin's), and audits the input with the target", async () => {
      await enrol(seed.users.clerk!);
      await openSession(seed.users.clerk!);
      await openSession(seed.users.both);
      await expect(setMfa({ userId: seed.users.clerk!, reset: true })).resolves.toEqual({ userId: seed.users.clerk, removed: 1, required: false });
      expect(auth.deletedFactorsOf).toEqual([seed.users.clerk]);
      expect(await factors(seed.users.clerk!)).toBe(0);
      expect(auth.signedOut).toEqual([seed.users.clerk]);
      expect(await sessions(seed.users.clerk!)).toBe(0);
      expect(await sessions(seed.users.both)).toBe(2);
      expect(await lastRun("kernel.admin.user.mfa.set", seed.users.both)).toMatchObject({ action: "update", input: { userId: seed.users.clerk, reset: true } });
    });

    it("ends no session when the reset found no factor to remove", async () => {
      await openSession(seed.users.idle!);
      await expect(setMfa({ userId: seed.users.idle!, reset: true })).resolves.toEqual({ userId: seed.users.idle, removed: 0, required: false });
      expect(auth.deletedFactorsOf).toEqual([seed.users.idle]);
      expect(auth.signedOut).toEqual([]);
      expect(await sessions(seed.users.idle!)).toBe(2);
    });

    it("lets the admin require and reset their own second step", async () => {
      await enrol(seed.users.both);
      await expect(setMfa({ userId: seed.users.both, required: true, reset: true })).resolves.toEqual({ userId: seed.users.both, removed: 1, required: true });
      expect(await seen(seed.users.both)).toEqual({ mfa_required: true });
      expect(await factors(seed.users.both)).toBe(0);
    });

    it("changes nothing in a dry run", async () => {
      await enrol(seed.users.clerk!);
      await expect(setMfa({ userId: seed.users.clerk!, reset: true, required: true }, admin, { dryRun: true })).resolves.toEqual({ userId: seed.users.clerk, removed: 0, required: true });
      expect(auth.deletedFactorsOf).toEqual([]);
      expect(auth.signedOut).toEqual([]);
      expect(await factors(seed.users.clerk!)).toBe(1);
      const [row] = await sql<{ mfa_required: boolean }[]>`select mfa_required from kernel.memberships where user_id = ${seed.users.clerk!} and company_id = ${companyId}`;
      expect(row!.mfa_required).toBe(false);
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

    it("requires the second step only where an administrator set it on the membership, an admin's included", async () => {
      // No role requires it by itself (owner decision 2026-11-04): the admin and the member start without it.
      expect(await hook(seed.users.boss!)).toMatchObject({ requires_mfa: false, active_company_id: companyId });
      await require(seed.users.boss!, true);
      expect(await hook(seed.users.boss!)).toMatchObject({ requires_mfa: true, active_company_id: companyId });
      await require(seed.users.boss!, false);
      expect(await hook(seed.users.boss!)).toMatchObject({ requires_mfa: false });
      await require(seed.users.clerk!, true);
      expect(await hook(seed.users.clerk!)).toMatchObject({ requires_mfa: true });
    });
  });
});
