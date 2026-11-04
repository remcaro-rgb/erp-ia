import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessError } from "@erp/kernel";

const calls = vi.hoisted(() => ({
  runProcess: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ removed: 1 })),
  logout: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  signOutIfDisabled: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
}));
const jar = vi.hoisted(() => ({ jar: true }));
vi.mock("@erp/kernel", async (original) => ({ ...(await original<typeof import("@erp/kernel")>()), runProcess: calls.runProcess }));
vi.mock("next/headers", () => ({ cookies: async () => jar }));
vi.mock("@/lib/auth/claims", () => ({ requireCaller: async () => ({ claims: { sub: "admin-1", active_company_id: "c1" }, origin: "ui" }) }));
vi.mock("@/lib/auth/disabled", () => ({ signOutIfDisabled: calls.signOutIfDisabled }));
vi.mock("@/lib/server/runtime", () => ({ processDeps: () => ({ deps: true }), registrySynced: async () => {} }));
vi.mock("./login", () => ({ logout: calls.logout }));

import { changeOwnPasswordAction, disableOwnMfaAction, resetUserPasswordAction, setUserMfaAction } from "./mfa-actions";
import { MFA_DISABLED_LOGIN } from "./notices";

// The second step's server actions (design §22.19): the processes run as the session's user with the step-up token the
// screen obtained; a refusal comes back as data (code + the process's messages) for the dialog or the user page to show.
// Removing a verified factor makes Auth end every session of its user: when that user is the caller, the action ends this
// session's cookies too and answers where the browser goes (the sign-in page with the notice); nothing else signs out.

const caller = (stepUpToken?: string) => ({ claims: { sub: "admin-1", active_company_id: "c1" }, origin: "ui", ...(stepUpToken ? { stepUpToken } : {}) });

beforeEach(() => {
  calls.runProcess.mockReset();
  calls.runProcess.mockImplementation(async () => ({ removed: 1 }));
  calls.logout.mockClear();
  calls.signOutIfDisabled.mockClear();
});

describe("disableOwnMfaAction", () => {
  it("runs kernel.user.mfa.disable with the token, ends this session and sends the browser to the sign-in notice", async () => {
    expect(await disableOwnMfaAction("tok-1")).toEqual({ ok: true, next: MFA_DISABLED_LOGIN });
    expect(MFA_DISABLED_LOGIN).toBe("/login?notice=mfa_disabled");
    expect(calls.runProcess).toHaveBeenCalledWith({ deps: true }, caller("tok-1"), "kernel.user.mfa.disable", {});
    expect(calls.logout).toHaveBeenCalledWith(jar);
  });

  it("without a token the process answers step_up_required: the refusal comes back as data and nobody is signed out", async () => {
    calls.runProcess.mockRejectedValueOnce(new ProcessError("step_up_required", "step-up required", { stage: "gate" }));
    expect(await disableOwnMfaAction()).toEqual({ ok: false, code: "step_up_required", details: [] });
    expect(calls.runProcess).toHaveBeenCalledWith({ deps: true }, caller(), "kernel.user.mfa.disable", {});
    expect(calls.logout).not.toHaveBeenCalled();
  });

  it("a second step an administrator requires: invalid_input with the process's copy, the session stays", async () => {
    const copy = "Un administrador exige tu verificación en dos pasos; pídele que deje de exigirla";
    calls.runProcess.mockRejectedValueOnce(new ProcessError("invalid_input", "mfa is required", { details: [copy] }));
    expect(await disableOwnMfaAction("tok-1")).toEqual({ ok: false, code: "invalid_input", details: [{ message: copy }] });
    expect(calls.logout).not.toHaveBeenCalled();
  });

  it("nothing removed (no factor): the session stays and the screen just refreshes", async () => {
    calls.runProcess.mockResolvedValueOnce({ removed: 0 });
    expect(await disableOwnMfaAction("tok-1")).toEqual({ ok: true, next: null });
    expect(calls.logout).not.toHaveBeenCalled();
  });

  it("an inactive membership is handed to the deactivated-session path; any other error is not swallowed", async () => {
    const inactive = new ProcessError("forbidden", "inactive", { stage: "gate" });
    calls.runProcess.mockRejectedValueOnce(inactive);
    expect(await disableOwnMfaAction("tok-1")).toEqual({ ok: false, code: "forbidden", details: [] });
    expect(calls.signOutIfDisabled).toHaveBeenCalledWith(inactive);
    calls.runProcess.mockRejectedValueOnce(new Error("database down"));
    await expect(disableOwnMfaAction("tok-1")).rejects.toThrow("database down");
  });
});

describe("setUserMfaAction", () => {
  it("resets another member's factor with kernel.admin.user.mfa.set; the admin's own session stays", async () => {
    calls.runProcess.mockResolvedValueOnce({ userId: "u-2", removed: 1, required: false });
    expect(await setUserMfaAction("u-2", { reset: true }, "tok-2")).toEqual({ ok: true, next: null });
    expect(calls.runProcess).toHaveBeenCalledWith({ deps: true }, caller("tok-2"), "kernel.admin.user.mfa.set", { userId: "u-2", reset: true });
    expect(calls.logout).not.toHaveBeenCalled();
  });

  it("requires the second step", async () => {
    calls.runProcess.mockResolvedValueOnce({ userId: "admin-1", removed: 0, required: true });
    expect(await setUserMfaAction("admin-1", { required: true }, "tok-2")).toEqual({ ok: true, next: null });
    expect(calls.runProcess).toHaveBeenCalledWith({ deps: true }, caller("tok-2"), "kernel.admin.user.mfa.set", { userId: "admin-1", required: true });
    expect(calls.logout).not.toHaveBeenCalled();
  });

  it("an admin who removes their own factor is signed out like a self-disable (Auth ended their sessions)", async () => {
    calls.runProcess.mockResolvedValueOnce({ userId: "admin-1", removed: 1, required: false });
    expect(await setUserMfaAction("admin-1", { reset: true }, "tok-2")).toEqual({ ok: true, next: MFA_DISABLED_LOGIN });
    expect(calls.logout).toHaveBeenCalledWith(jar);
  });

  it("maps refusals: forbidden for a non-admin, invalid_input for a user of another company", async () => {
    calls.runProcess.mockRejectedValueOnce(new ProcessError("forbidden", "not an admin"));
    expect(await setUserMfaAction("u-2", { reset: true }, "tok-2")).toEqual({ ok: false, code: "forbidden", details: [] });
    calls.runProcess.mockRejectedValueOnce(new ProcessError("invalid_input", "not a member", { details: ["El usuario no pertenece a la empresa"] }));
    expect(await setUserMfaAction("u-9", { required: true }, "tok-2")).toEqual({ ok: false, code: "invalid_input", details: [{ message: "El usuario no pertenece a la empresa" }] });
    expect(calls.logout).not.toHaveBeenCalled();
  });

  it("builds the input from its own arguments: a userId smuggled in `change` never replaces the target", async () => {
    calls.runProcess.mockResolvedValueOnce({ userId: "u-2", removed: 1, required: false });
    const tampered = { reset: true, userId: "victim", extra: 1 } as unknown as { reset?: boolean; required?: boolean };
    await setUserMfaAction("u-2", tampered, "tok-2");
    expect(calls.runProcess.mock.calls[0]![3]).toStrictEqual({ userId: "u-2", reset: true });
  });

  it("decides the self sign-out from the process's answer (whose factor it removed), not from the argument", async () => {
    // The process answered about the caller: signed out.
    calls.runProcess.mockResolvedValueOnce({ userId: "admin-1", removed: 1, required: false });
    expect(await setUserMfaAction("u-2", { reset: true }, "tok-2")).toEqual({ ok: true, next: MFA_DISABLED_LOGIN });
    calls.logout.mockClear();
    // The process answered about someone else: the caller's session stays.
    calls.runProcess.mockResolvedValueOnce({ userId: "u-2", removed: 1, required: false });
    expect(await setUserMfaAction("admin-1", { reset: true }, "tok-2")).toEqual({ ok: true, next: null });
    expect(calls.logout).not.toHaveBeenCalled();
  });
});


describe("changeOwnPasswordAction", () => {
  it("runs kernel.user.password.change with both passwords and no step-up, and the session stays", async () => {
    calls.runProcess.mockResolvedValueOnce({ changed: true });
    expect(await changeOwnPasswordAction("vieja-clave-1", "nueva-clave-2")).toEqual({ ok: true });
    expect(calls.runProcess).toHaveBeenCalledWith({ deps: true }, caller(), "kernel.user.password.change", { currentPassword: "vieja-clave-1", newPassword: "nueva-clave-2" });
    expect(calls.logout).not.toHaveBeenCalled();
  });

  it("a wrong current password comes back as data, with the process's copy", async () => {
    calls.runProcess.mockRejectedValueOnce(new ProcessError("invalid_input", "wrong current password", { details: ["La contraseña actual no es correcta"] }));
    expect(await changeOwnPasswordAction("mala", "nueva-clave-2")).toEqual({ ok: false, code: "invalid_input", details: [{ message: "La contraseña actual no es correcta" }] });
  });
});

describe("resetUserPasswordAction", () => {
  it("resets another member's password with the step-up token; the admin's own session stays", async () => {
    calls.runProcess.mockResolvedValueOnce({ userId: "u-2" });
    expect(await resetUserPasswordAction("u-2", "clave-nueva-9", "tok-3")).toEqual({ ok: true, next: null });
    expect(calls.runProcess).toHaveBeenCalledWith({ deps: true }, caller("tok-3"), "kernel.admin.user.password.reset", { userId: "u-2", newPassword: "clave-nueva-9" });
    expect(calls.logout).not.toHaveBeenCalled();
  });

  it("an admin who resets their own password is signed out and sent to the sign-in page (the process ended their sessions)", async () => {
    calls.runProcess.mockResolvedValueOnce({ userId: "admin-1" });
    expect(await resetUserPasswordAction("admin-1", "clave-nueva-9", "tok-3")).toEqual({ ok: true, next: "/login" });
    expect(calls.logout).toHaveBeenCalledWith(jar);
  });

  it("without the token the process asks for the step-up; a non-admin is forbidden", async () => {
    calls.runProcess.mockRejectedValueOnce(new ProcessError("step_up_required", "step-up required", { stage: "gate" }));
    expect(await resetUserPasswordAction("u-2", "clave-nueva-9")).toEqual({ ok: false, code: "step_up_required", details: [] });
    calls.runProcess.mockRejectedValueOnce(new ProcessError("forbidden", "not an admin"));
    expect(await resetUserPasswordAction("u-2", "clave-nueva-9", "tok-3")).toEqual({ ok: false, code: "forbidden", details: [] });
    expect(calls.logout).not.toHaveBeenCalled();
  });
});
