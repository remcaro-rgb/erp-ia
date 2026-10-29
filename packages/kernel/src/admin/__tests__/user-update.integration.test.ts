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
});
