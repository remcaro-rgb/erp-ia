import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims, type JwtClaims } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { Registry } from "../../registry";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { runProcess } from "../../process/run";
import { isMembershipInactive, ProcessError } from "../../process/errors";
import { runnableProcesses } from "../../process/permissions";
import type { Caller } from "../../process/context";
import { callerProfile } from "../../user-prefs/profile";
import { syncRegistry } from "../sync";
import { setUserRoles } from "../roles";
import { setAuditContext } from "../../audit/audit";
import type { ProcessContext } from "../../process/context";

// Editable users (design §22.16, Task 7) and migration 0027_kernel_user_update (rule 34): kernel.admin.user.update changes
// a member's name, mobile, photo, locale, roles and active state with the step-up. Deactivating keeps the history and the
// roles but removes access at once: the old claims of an inactive member are refused by kernel.can_run_process (0025:
// current_role_ids ignores the membership) and, explicitly, by runProcess's gate, even for an admin's claims; the shell
// reads the same state through callerProfile. An admin never deactivates themselves, and the company always keeps an
// active admin.

describe("kernel.admin.user.update", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let memberRoleId: string;
  let extraRoleId: string;
  let admin: Caller;
  /** The claims `clerk` (a member) and `boss` (a second admin) received while active: reused after the deactivation. */
  let clerkClaims: JwtClaims;
  let bossClaims: JwtClaims;

  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${companyId}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const update = async <T = unknown>(input: Record<string, unknown>, caller: Caller = admin): Promise<T> =>
    runProcess({ sql, registry }, await stepUp(caller), "kernel.admin.user.update", input);
  const membership = async (userId: string) =>
    (await sql<{ id: string; is_active: boolean }[]>`select id, is_active from kernel.memberships where company_id = ${companyId} and user_id = ${userId}`)[0]!;
  const rolesOf = async (userId: string) =>
    (
      await sql<{ role_id: string }[]>`
        select mr.role_id from kernel.membership_roles mr join kernel.memberships m on m.id = mr.membership_id
        where m.company_id = ${companyId} and m.user_id = ${userId} order by mr.role_id`
    ).map((r) => r.role_id);
  const details = (error: unknown) => (error instanceof ProcessError && Array.isArray(error.details) ? error.details.map(String) : []);

  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [kernelModule]);
    seed = await seedTenant(sql, {
      companies: 1,
      entitlements: [],
      users: [
        { name: "clerk", companies: [0], role: "member" },
        { name: "boss", companies: [0], role: "admin" },
      ],
    });
    companyId = seed.companies[0]!.id;
    memberRoleId = seed.companies[0]!.memberRoleId;
    await syncRegistry(sql, registry);
    await sql`select kernel.seed_company_defaults(${companyId})`;
    const [extra] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'bodega', false) returning id`;
    extraRoleId = extra!.id;
    await sql`select kernel.seed_role_defaults(${companyId}, ${extraRoleId})`;
    await sql`update kernel.users set mobile_cc = '57', mobile = '3001234567' where id = ${seed.users.clerk!}`;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    clerkClaims = seed.claimsFor(seed.users.clerk!, companyId);
    bossClaims = seed.claimsFor(seed.users.boss!, companyId);
  });
  afterAll(async () => {
    await seed.cleanup();
    await sql.end();
  });

  it("is a step-up update of the admin feature that the system admin role holds", () => {
    const def = registry.process("kernel.admin.user.update");
    expect(def).toMatchObject({ module: "kernel", kind: "update", feature: "kernel.admin", sensitivity: "step-up" });
  });

  it("changes the name, mobile, locale and photo, and the audit records each field before and after (the photo hidden)", async () => {
    const photo = "data:image/png;base64,iVBORw0KGgo=";
    const out = await update<{ id: string }>({ userId: seed.users.clerk!, name: "Ana Pérez", mobileCc: "57", mobile: "3109876543", locale: "en", photo });
    expect(out.id).toBe(seed.users.clerk);
    const [user] = await sql`select full_name, mobile_cc, mobile, locale, photo from kernel.users where id = ${seed.users.clerk!}`;
    expect(user).toEqual({ full_name: "Ana Pérez", mobile_cc: "57", mobile: "3109876543", locale: "en", photo });

    const entries = await sql<{ entity: string; row_id: string; action: string; input: Record<string, unknown> | null; diff: Record<string, { old: unknown; new: unknown }> | null }[]>`
      select entity, row_id, action, input, diff from kernel.audit_log
      where company_id = ${companyId} and process_id = 'kernel.admin.user.update' and row_id = ${seed.users.clerk!} order by occurred_at, id`;
    const profile = entries.find((e) => e.entity === "kernel.users")!;
    expect(profile).toMatchObject({ action: "update" });
    expect(profile.diff).toMatchObject({
      full_name: { old: "User clerk", new: "Ana Pérez" },
      mobile: { old: "3001234567", new: "3109876543" },
      locale: { old: "es-419", new: "en" },
      photo: { old: null, new: "(foto)" },
    });
    const run = entries.find((e) => e.entity !== "kernel.users")!;
    expect(run.input).toMatchObject({ userId: seed.users.clerk, name: "Ana Pérez", photo: "(foto)" });
    expect(JSON.stringify(entries)).not.toContain("iVBORw0KGgo");

    // Only what is sent changes; `photo: null` removes the picture.
    await update({ userId: seed.users.clerk!, photo: null });
    const [after] = await sql`select full_name, mobile, photo from kernel.users where id = ${seed.users.clerk!}`;
    expect(after).toEqual({ full_name: "Ana Pérez", mobile: "3109876543", photo: null });
  });

  it("refuses an invalid mobile, an unknown locale, an empty change and a user of another company", async () => {
    await expect(update({ userId: seed.users.clerk!, mobileCc: "57", mobile: "12" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(update({ userId: seed.users.clerk!, locale: "fr" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(update({ userId: seed.users.clerk! })).rejects.toMatchObject({ code: "invalid_input" });
    const stranger = await seedTenant(sql, { companies: 1, entitlements: [] });
    try {
      const error = await update({ userId: stranger.users.both, name: "X" }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(details(error)).toContain("El usuario no pertenece a la empresa");
    } finally {
      await stranger.cleanup();
    }
  });

  it("replaces the roles through the user_role.set rules: at least one role, never the admin's own admin role", async () => {
    await update({ userId: seed.users.clerk!, roleIds: [memberRoleId, extraRoleId] });
    expect(await rolesOf(seed.users.clerk!)).toEqual([memberRoleId, extraRoleId].sort());
    await expect(update({ userId: seed.users.clerk!, roleIds: [] })).rejects.toMatchObject({ code: "invalid_input" });
    const own = await update({ userId: seed.users.both, roleIds: [memberRoleId] }).catch((e: unknown) => e);
    expect(own).toMatchObject({ code: "invalid_input" });
    expect(details(own)).toContain("No puedes quitarte tu propio rol admin");
    await update({ userId: seed.users.clerk!, roleIds: [memberRoleId] });
    expect(await rolesOf(seed.users.clerk!)).toEqual([memberRoleId]);
  });

  it("deactivates a member keeping their roles and history; their old claims are refused by can_run_process and by runProcess", async () => {
    await update({ userId: seed.users.clerk!, active: false });
    expect((await membership(seed.users.clerk!)).is_active).toBe(false);
    expect(await rolesOf(seed.users.clerk!)).toEqual([memberRoleId]);
    // The admin's views show the state.
    const [listed] = await withClaims(sql, admin.claims, (tx) => tx<{ is_active: boolean }[]>`select is_active from kernel.v_memberships where user_id = ${seed.users.clerk!}`);
    expect(listed!.is_active).toBe(false);
    const [user] = await withClaims(sql, admin.claims, (tx) => tx<{ is_active: boolean }[]>`select is_active from kernel.v_users where id = ${seed.users.clerk!}`);
    expect(user!.is_active).toBe(false);

    const [probe] = await withClaims(sql, clerkClaims, (tx) => tx<{ roles: string[]; can: boolean; inactive: boolean }[]>`
      select kernel.current_role_ids() as roles, kernel.can_run_process('kernel.saved_view.list') as can, kernel.membership_inactive() as inactive`);
    expect(probe).toEqual({ roles: [], can: false, inactive: true });
    // A self-service process needs only membership of the company: the gate refuses the inactive membership explicitly.
    const refused = await runProcess({ sql, registry }, { claims: clerkClaims, origin: "ui" }, "kernel.user_prefs.set", { key: "theme", value: "dark" }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "forbidden", stage: "gate" });
    expect(isMembershipInactive(refused)).toBe(true);
    expect([...(await runnableProcesses(sql, registry, clerkClaims, ["kernel.user_prefs.set", "kernel.saved_view.list"]))]).toEqual([]);
    expect((await callerProfile(sql, clerkClaims)).active).toBe(false);
    // The denial is in the audit, on the inactive member's name.
    const [denied] = await sql`select action from kernel.audit_log where company_id = ${companyId} and actor_user_id = ${seed.users.clerk!} and process_id = 'kernel.user_prefs.set' order by occurred_at desc limit 1`;
    expect(denied).toEqual({ action: "denied" });
  });

  it("refuses an inactive admin's old claims too: the admin short-circuit does not bypass the membership check", async () => {
    await update({ userId: seed.users.boss!, active: false });
    const [probe] = await withClaims(sql, bossClaims, (tx) => tx<{ admin: boolean; can: boolean }[]>`
      select kernel.is_company_admin() as admin, kernel.can_run_process('kernel.admin.permission.matrix') as can`);
    expect(probe).toEqual({ admin: false, can: false });
    const refused = await runProcess({ sql, registry }, { claims: bossClaims, origin: "ui" }, "kernel.admin.permission.matrix", {}).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "forbidden", stage: "gate" });
    expect(isMembershipInactive(refused)).toBe(true);
  });

  it("reactivates: the same claims work again", async () => {
    await update({ userId: seed.users.clerk!, active: true });
    await update({ userId: seed.users.boss!, active: true });
    expect((await membership(seed.users.clerk!)).is_active).toBe(true);
    await expect(runProcess({ sql, registry }, { claims: clerkClaims, origin: "ui" }, "kernel.user_prefs.set", { key: "theme", value: "dark" })).resolves.toBeDefined();
    await expect(runProcess({ sql, registry }, { claims: bossClaims, origin: "ui" }, "kernel.admin.permission.matrix", {})).resolves.toBeDefined();
    expect((await callerProfile(sql, clerkClaims)).active).toBe(true);
  });

  it("an admin cannot deactivate themselves", async () => {
    const error = await update({ userId: seed.users.both, active: false }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect(details(error)).toEqual(["No puedes desactivar tu propia cuenta"]);
    expect((await membership(seed.users.both)).is_active).toBe(true);
  });

  it("the company keeps at least one active admin: deactivating the last one is refused, whoever writes", async () => {
    // onlyA and boss hold the admin role too: once they are inactive, `both` is the last active admin.
    await update({ userId: seed.users.onlyA, active: false });
    await update({ userId: seed.users.boss!, active: false });
    try {
      await expect(sql`update kernel.memberships set is_active = false where company_id = ${companyId} and user_id = ${seed.users.both}`).rejects.toThrow(
        "erp:invalid_input:La empresa necesita al menos un administrador activo",
      );
      // A member without the admin role is not counted and not protected.
      await update({ userId: seed.users.clerk!, active: false });
      await update({ userId: seed.users.clerk!, active: true });
    } finally {
      await update({ userId: seed.users.onlyA, active: true });
      await update({ userId: seed.users.boss!, active: true });
    }
  });

  it("only the admin runs it: a member is refused at the gate, and the tables refuse bare writes", async () => {
    const member: Caller = { claims: clerkClaims, origin: "ui" };
    await expect(update({ userId: seed.users.onlyA, name: "Hack" }, member)).rejects.toMatchObject({ code: "forbidden" });
    // Inside the process's audit context a member is still not the admin.
    await expect(
      withClaims(sql, clerkClaims, async (tx) => {
        await tx`select set_config('erp.audit_process_id', 'kernel.admin.user.update', true)`;
        await tx`select kernel.admin_update_user(${seed.users.onlyA}, 'Hack', null, null, false, null, null)`;
      }),
    ).rejects.toThrow(/kernel.admin.user.update/);
    // The admin without the process: a bare statement changes no membership, and no profile.
    await expect(withClaims(sql, admin.claims, (tx) => tx`update kernel.memberships set is_active = false where user_id = ${seed.users.clerk!} returning id`)).resolves.toHaveLength(0);
    await expect(withClaims(sql, admin.claims, (tx) => tx`select kernel.admin_update_user(${seed.users.clerk!}, 'Hack', null, null, false, null, null)`)).rejects.toThrow(/kernel.admin.user.update/);
    const [user] = await sql`select full_name from kernel.users where id = ${seed.users.onlyA}`;
    expect(user).toEqual({ full_name: "User onlyA" });
  });

  it("the migration lets kernel.admin.user.update write a member's roles, and only the admin processes of users", async () => {
    const [grants] = await sql<{ anon: boolean; auth: boolean }[]>`
      select has_function_privilege('anon', 'kernel.membership_inactive()', 'execute') as anon,
             has_function_privilege('authenticated', 'kernel.membership_inactive()', 'execute') as auth`;
    expect(grants).toEqual({ anon: false, auth: true });
    const clerk = await membership(seed.users.clerk!);
    await expect(
      withClaims(sql, admin.claims, async (tx) => {
        await tx`select set_config('erp.audit_process_id', 'kernel.admin.role.update', true)`;
        await tx`insert into kernel.membership_roles (membership_id, role_id) values (${clerk.id}, ${extraRoleId})`;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("a mobile sent without its country code keeps the stored code (never Colombia's by default)", async () => {
    await sql`update kernel.users set mobile_cc = '1', mobile = '2025550123' where id = ${seed.users.clerk!}`;
    try {
      await update({ userId: seed.users.clerk!, mobile: "2025550199" });
      const [user] = await sql`select mobile_cc, mobile from kernel.users where id = ${seed.users.clerk!}`;
      expect(user).toEqual({ mobile_cc: "1", mobile: "2025550199" });
      // Validated against the stored code: 5 digits are too few for +1.
      const error = await update({ userId: seed.users.clerk!, mobile: "20255" }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(JSON.stringify((error as ProcessError).details)).toContain("6 a 14 dígitos");
    } finally {
      await sql`update kernel.users set mobile_cc = '57', mobile = '3109876543' where id = ${seed.users.clerk!}`;
    }
  });

  it("a deactivation takes the company lock before the membership row (company, then membership: no deadlock)", async () => {
    const held = await sql.reserve();
    try {
      await held`begin`;
      await held`select 1 from kernel.companies where id = ${companyId} for no key update`;
      const running = update({ userId: seed.users.clerk!, active: false });
      await new Promise((resolve) => setTimeout(resolve, 400));
      // The waiting run has not touched the membership yet: its row is free.
      const clerk = await membership(seed.users.clerk!);
      await expect(sql.begin((tx) => tx`select id from kernel.memberships where id = ${clerk.id} for update nowait`)).resolves.toHaveLength(1);
      await held`commit`;
      await running;
    } finally {
      held.release();
    }
    expect((await membership(seed.users.clerk!)).is_active).toBe(false);
    await update({ userId: seed.users.clerk!, active: true });
  });

  it("only the gate's refusal counts as the inactive-membership refusal", () => {
    const details = { reason: "membership_inactive" };
    expect(isMembershipInactive(new ProcessError("forbidden", "x", { details, stage: "gate" }))).toBe(true);
    expect(isMembershipInactive(new ProcessError("forbidden", "x", { details }))).toBe(false);
    expect(isMembershipInactive(new ProcessError("invalid_input", "x", { details, stage: "gate" }))).toBe(false);
  });

  it("removing the admin role keeps an active admin: refused for the last one, allowed while another remains", async () => {
    // boss loses the admin role while `both` (the caller) is an active admin: allowed.
    await update({ userId: seed.users.boss!, roleIds: [memberRoleId] });
    expect(await rolesOf(seed.users.boss!)).toEqual([memberRoleId]);
    await update({ userId: seed.users.boss!, roleIds: [seed.companies[0]!.adminRoleId] });
    // With onlyA and boss inactive, `both` is the last active admin. The caller can never remove their own admin role,
    // so the guard is reached here through the shared helper with a context that is not `both`'s own (as a concurrent
    // admin's removal would see it).
    await update({ userId: seed.users.onlyA, active: false });
    await update({ userId: seed.users.boss!, active: false });
    try {
      const refused = await withClaims(sql, admin.claims, async (tx) => {
        await setAuditContext(tx, { origin: "ui", processId: "kernel.admin.user_role.set", chainId: randomUUID(), actorUserId: admin.claims.sub });
        const ctx = { tx, registry, companyId, tenantId: seed.tenantId, userId: seed.users.boss!, roleIds: [], locale: "es-419", origin: "ui", chainId: randomUUID(), dryRun: false } as unknown as ProcessContext;
        return setUserRoles(ctx, { userId: seed.users.both, roleIds: [memberRoleId] }).catch((e: unknown) => e);
      });
      expect(refused).toMatchObject({ code: "invalid_input" });
      expect(details(refused)).toEqual(["La empresa necesita al menos un administrador activo"]);
      expect(await rolesOf(seed.users.both)).toContain(seed.companies[0]!.adminRoleId);
    } finally {
      await update({ userId: seed.users.onlyA, active: true });
      await update({ userId: seed.users.boss!, active: true });
    }
  });
});

// Deactivation is per company (review of Task 7, migration 0027): the access token hook prefers an active membership and
// lists only active memberships in company_ids, so a person deactivated in company B keeps working in A; only someone with
// no active membership left is locked out.
describe("deactivation in one company of several", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let a: string;
  let b: string;
  let multi: string;

  const hook = async (wanted?: string) => {
    const [row] = await sql<{ hook: { claims: JwtClaims } }[]>`
      select kernel.custom_access_token_hook(${sql.json({ user_id: multi, claims: { sub: multi, ...(wanted ? { app_metadata: { active_company_id: wanted } } : {}) } })}) as hook`;
    return row!.hook.claims;
  };
  const setActive = (company: string, active: boolean) => sql`update kernel.memberships set is_active = ${active} where user_id = ${multi} and company_id = ${company}`;

  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [kernelModule]);
    seed = await seedTenant(sql, { companies: 2, entitlements: [], users: [{ name: "multi", companies: [0, 1], role: "member" }] });
    a = seed.companies[0]!.id;
    b = seed.companies[1]!.id;
    multi = seed.users.multi!;
    await syncRegistry(sql, registry);
    for (const company of [a, b]) await sql`select kernel.seed_company_defaults(${company})`;
  });
  afterAll(async () => {
    await seed.cleanup();
    await sql.end();
  });

  it("active in both: the requested company is the active one and both are listed", async () => {
    const claims = await hook(b);
    expect(claims.active_company_id).toBe(b);
    expect([...claims.company_ids].sort()).toEqual([a, b].sort());
    expect(claims).not.toHaveProperty("inactive_company_id");
  });

  it("inactive in B: B requested resolves to A, company_ids is [A], and the session works in A", async () => {
    await setActive(b, false);
    try {
      const claims = await hook(b);
      expect(claims.active_company_id).toBe(a);
      expect(claims.company_ids).toEqual([a]);
      // The claim names the company passed over, so the web app stores and audits the move.
      expect((claims as unknown as Record<string, unknown>).inactive_company_id).toBe(b);
      // Without a stored choice the first membership (A) is still the pick: nothing was passed over.
      expect((await hook()).active_company_id).toBe(a);
      expect(await hook()).not.toHaveProperty("inactive_company_id");
      await expect(runProcess({ sql, registry }, { claims, origin: "ui" }, "kernel.user_prefs.set", { key: "theme", value: "dark" })).resolves.toBeDefined();
      // A token issued before the change still names B: the database answers only A, and the switcher offers only A.
      const stale: JwtClaims = { ...claims, company_ids: [a, b] };
      const [row] = await withClaims(sql, stale, (tx) => tx<{ ids: string[] }[]>`select kernel.active_company_ids() as ids`);
      expect(row!.ids).toEqual([a]);
      expect((await callerProfile(sql, stale)).companies.map((c) => c.id)).toEqual([a]);
    } finally {
      await setActive(b, true);
    }
  });

  it("inactive everywhere: the claims name the requested company with no company_ids, and every run is refused as inactive", async () => {
    await setActive(a, false);
    await setActive(b, false);
    try {
      const claims = await hook(b);
      expect(claims.active_company_id).toBe(b);
      expect(claims.company_ids).toEqual([]);
      expect(claims).not.toHaveProperty("inactive_company_id");
      const refused = await runProcess({ sql, registry }, { claims, origin: "ui" }, "kernel.user_prefs.set", { key: "theme", value: "dark" }).catch((e: unknown) => e);
      expect(isMembershipInactive(refused)).toBe(true);
      // The refusal is still audited on their name, in that company.
      const [denied] = await sql`select company_id, action from kernel.audit_log where actor_user_id = ${multi} and process_id = 'kernel.user_prefs.set' order by occurred_at desc limit 1`;
      expect(denied).toEqual({ company_id: b, action: "denied" });
      expect((await callerProfile(sql, claims)).active).toBe(false);
    } finally {
      await setActive(a, true);
      await setActive(b, true);
    }
  });
});
