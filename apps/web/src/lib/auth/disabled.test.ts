import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBERSHIP_INACTIVE, ProcessError } from "@erp/kernel";

const calls = vi.hoisted(() => ({
  logout: vi.fn(async () => {}),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
  leave: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: calls.redirect }));
vi.mock("@/lib/supabase/server", () => ({ createSupabase: () => ({}) }));
vi.mock("./claims", () => ({ getSessionState: async () => ({ userId: "u", claims: { sub: "u", active_company_id: "b" } }) }));
vi.mock("./inactive", () => ({ leaveInactiveCompany: calls.leave }));
vi.mock("./login", () => ({ logout: calls.logout }));

import { ACCOUNT_DISABLED_LOGIN, signOutIfDisabled } from "./disabled";

// A server action whose run was refused because the admin deactivated the caller's membership in the active company
// (design §22.16) moves the session to another company where the person is still active and goes home; with none left it
// ends the session and sends the browser to the sign-in page with the reason. Any other refusal is left to the action.

const refusal = () => new ProcessError("forbidden", "inactive", { details: { reason: MEMBERSHIP_INACTIVE }, stage: "gate" });

describe("signOutIfDisabled", () => {
  beforeEach(() => {
    calls.logout.mockClear();
    calls.redirect.mockClear();
    calls.leave.mockReset();
  });

  it("with no active membership left: signs out and redirects to the sign-in page with the reason", async () => {
    calls.leave.mockResolvedValue(null);
    await expect(signOutIfDisabled(refusal())).rejects.toThrow(`NEXT_REDIRECT ${ACCOUNT_DISABLED_LOGIN}`);
    expect(calls.logout).toHaveBeenCalledTimes(1);
    expect(ACCOUNT_DISABLED_LOGIN).toBe("/login?error=account_disabled");
  });

  it("active in another company: moves there and goes home, without signing out", async () => {
    calls.leave.mockResolvedValue({ userId: "u", claims: { active_company_id: "a" } });
    await expect(signOutIfDisabled(refusal())).rejects.toThrow("NEXT_REDIRECT /");
    expect(calls.logout).not.toHaveBeenCalled();
  });

  it("does nothing for any other refusal or error", async () => {
    for (const error of [new ProcessError("forbidden", "no role"), new ProcessError("invalid_input", "x", { details: [{ reason: MEMBERSHIP_INACTIVE }] }), new Error("boom")]) {
      await expect(signOutIfDisabled(error)).resolves.toBeUndefined();
    }
    expect(calls.logout).not.toHaveBeenCalled();
    expect(calls.redirect).not.toHaveBeenCalled();
  });
});
