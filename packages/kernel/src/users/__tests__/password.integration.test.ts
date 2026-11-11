import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JwtClaims } from "../../db/client";
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

// Passwords (owner decision 2026-11-04): a user changes their own with kernel.user.password.change (the current password
// proves who they are), the company admin resets a member's with kernel.admin.user.password.reset (step-up). The identity
// provider holds them (here the database double); nothing about a password reaches the audit log.

describe("passwords", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let auth: DbAuthAdmin;
  let companyId: string;
  let admin: Caller;
  let clerk: Caller;
  let outsider: Caller;
  let other: Awaited<ReturnType<typeof seedTenant>>;

  const caller = (claims: JwtClaims): Caller => ({ claims, origin: "ui" });
  const details = (error: unknown) => (error instanceof ProcessError && Array.isArray(error.details) ? error.details.map(String) : []);
  const change = (who: Caller, input: Record<string, unknown>, options: { dryRun?: boolean } = {}) =>
    runProcess({ sql, registry }, who, "kernel.user.password.change", input, options);
  const reset = async (who: Caller, input: Record<string, unknown>, options: { dryRun?: boolean } = {}) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${who.claims.sub}, ${companyId}, ${stepUpToken})`;
    return runProcess({ sql, registry }, { ...who, stepUpToken }, "kernel.admin.user.password.reset", input, options);
  };

  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [kernelModule]);
    seed = await seedTenant(sql, { companies: 1, entitlements: [], users: [{ name: "clerk", companies: [0], role: "member" }] });
    other = await seedTenant(sql, { companies: 1, entitlements: [] });
    companyId = seed.companies[0]!.id;
    await syncRegistry(sql, registry);
    await sql`select kernel.seed_company_defaults(${companyId})`;
    admin = caller(seed.claimsFor(seed.users.both, companyId));
    clerk = caller(seed.claimsFor(seed.users.clerk!, companyId));
    outsider = caller(other.claimsFor(other.users.both, other.companies[0]!.id));
    auth = new DbAuthAdmin(sql);
    setAuthAdmin(auth);
    auth.passwords.set(seed.users.clerk!, "clave-actual-1");
  });
  afterAll(async () => {
    setAuthAdmin(undefined);
    await auth.cleanup();
    await other.cleanup();
    await seed.cleanup();
    await sql.end();
  });

  describe("kernel.user.password.change", () => {
    it("is a self-service update of the users feature, with no step-up, and the assistant has no such tool", () => {
      expect(registry.process("kernel.user.password.change")).toMatchObject({ module: "kernel", kind: "update", feature: "kernel.users", permission: "none" });
      expect(registry.process("kernel.user.password.change").sensitivity).not.toBe("step-up");
    });

    it("changes the caller's own password when the current one is right", async () => {
      await expect(change(clerk, { currentPassword: "clave-actual-1", newPassword: "clave-nueva-22" })).resolves.toEqual({ changed: true });
      expect(auth.passwords.get(seed.users.clerk!)).toBe("clave-nueva-22");
    });

    it("refuses a wrong current password and leaves the password as it was", async () => {
      const error = await change(clerk, { currentPassword: "equivocada-1", newPassword: "otra-clave-33" }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(details(error)).toEqual(["La contraseña actual no es correcta"]);
      expect(auth.passwords.get(seed.users.clerk!)).toBe("clave-nueva-22");
    });

    it("refuses a new password that is too short, too long or the same as the current one", async () => {
      await expect(change(clerk, { currentPassword: "clave-nueva-22", newPassword: "corta" })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(change(clerk, { currentPassword: "clave-nueva-22", newPassword: "x".repeat(73) })).rejects.toMatchObject({ code: "invalid_input" });
      const same = await change(clerk, { currentPassword: "clave-nueva-22", newPassword: "clave-nueva-22" }).catch((e: unknown) => e);
      expect(details(same)).toEqual(["La contraseña nueva debe ser distinta de la actual"]);
      expect(auth.passwords.get(seed.users.clerk!)).toBe("clave-nueva-22");
    });

    it("changes nothing in a dry run, and the audit entry never holds a password", async () => {
      await expect(change(clerk, { currentPassword: "clave-nueva-22", newPassword: "clave-simulada-4" }, { dryRun: true })).resolves.toEqual({ changed: false });
      expect(auth.passwords.get(seed.users.clerk!)).toBe("clave-nueva-22");
      await change(clerk, { currentPassword: "clave-nueva-22", newPassword: "clave-auditada-5" });
      const rows = await sql<{ input: unknown }[]>`select input from kernel.audit_log where company_id = ${companyId} and process_id = 'kernel.user.password.change'`;
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toMatch(/clave-/);
    });
  });

  describe("kernel.admin.user.password.reset", () => {
    it("is a step-up update of the admin feature", () => {
      expect(registry.process("kernel.admin.user.password.reset")).toMatchObject({ module: "kernel", kind: "update", feature: "kernel.admin", sensitivity: "step-up" });
    });

    it("sets a member's password and ends their sessions, never the admin's", async () => {
      auth.signedOut.length = 0;
      await expect(reset(admin, { userId: seed.users.clerk!, newPassword: "restablecida-66" })).resolves.toEqual({ userId: seed.users.clerk });
      expect(auth.passwords.get(seed.users.clerk!)).toBe("restablecida-66");
      expect(auth.signedOut).toEqual([seed.users.clerk]);
    });

    it("lets the admin reset their own password", async () => {
      await expect(reset(admin, { userId: seed.users.both, newPassword: "propia-nueva-77" })).resolves.toEqual({ userId: seed.users.both });
      expect(auth.passwords.get(seed.users.both)).toBe("propia-nueva-77");
    });

    it("refuses a caller who is not the company admin", async () => {
      await expect(reset(clerk, { userId: seed.users.both, newPassword: "no-permitida-8" })).rejects.toMatchObject({ code: "forbidden" });
      expect(auth.passwords.get(seed.users.both)).toBe("propia-nueva-77");
    });

    it("refuses a user who is not a member of the company, an unsafe password, and a dry run changes nothing", async () => {
      const stranger = await reset(admin, { userId: other.users.both, newPassword: "ajena-clave-9" }).catch((e: unknown) => e);
      expect(details(stranger)).toEqual(["El usuario no pertenece a la empresa"]);
      await expect(reset(admin, { userId: seed.users.clerk!, newPassword: "corta" })).rejects.toMatchObject({ code: "invalid_input" });
      auth.signedOut.length = 0;
      await expect(reset(admin, { userId: seed.users.clerk!, newPassword: "simulada-1234" }, { dryRun: true })).resolves.toEqual({ userId: seed.users.clerk });
      expect(auth.passwords.get(seed.users.clerk!)).toBe("restablecida-66");
      expect(auth.signedOut).toEqual([]);
    });

    it("asks for the step-up, and the audit entry names the target but holds no password", async () => {
      const bare = await runProcess({ sql, registry }, admin, "kernel.admin.user.password.reset", { userId: seed.users.clerk!, newPassword: "sin-paso-1234" }).catch((e: unknown) => e);
      expect(bare).toMatchObject({ code: "step_up_required" });
      await reset(admin, { userId: seed.users.clerk!, newPassword: "auditada-1234" });
      const rows = await sql<{ input: Record<string, unknown> | null }[]>`select input from kernel.audit_log where company_id = ${companyId} and process_id = 'kernel.admin.user.password.reset' order by occurred_at desc limit 1`;
      expect(rows[0]!.input).toEqual({ userId: seed.users.clerk });
      expect(outsider.claims.sub).toBeTruthy();
    });
  });
});
