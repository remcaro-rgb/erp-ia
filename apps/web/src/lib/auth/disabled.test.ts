import { describe, expect, it, vi } from "vitest";
import { MEMBERSHIP_INACTIVE, ProcessError } from "@erp/kernel";

const calls = vi.hoisted(() => ({ logout: vi.fn(async () => {}), redirect: vi.fn((path: string) => { throw new Error(`NEXT_REDIRECT ${path}`); }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: calls.redirect }));
vi.mock("./login", () => ({ logout: calls.logout }));

import { ACCOUNT_DISABLED_LOGIN, signOutIfDisabled } from "./disabled";

// A server action whose run was refused because the admin deactivated the caller's membership (design §22.16) ends the
// session and sends the browser to the sign-in page with the reason; any other refusal is left to the action.

describe("signOutIfDisabled", () => {
  it("signs out and redirects on the refusal of an inactive membership", async () => {
    const refusal = new ProcessError("forbidden", "inactive", { details: { reason: MEMBERSHIP_INACTIVE }, stage: "gate" });
    await expect(signOutIfDisabled(refusal)).rejects.toThrow(`NEXT_REDIRECT ${ACCOUNT_DISABLED_LOGIN}`);
    expect(calls.logout).toHaveBeenCalledTimes(1);
    expect(ACCOUNT_DISABLED_LOGIN).toBe("/login?error=account_disabled");
  });

  it("does nothing for any other refusal or error", async () => {
    calls.logout.mockClear();
    for (const error of [new ProcessError("forbidden", "no role"), new ProcessError("invalid_input", "x", { details: [{ reason: MEMBERSHIP_INACTIVE }] }), new Error("boom")]) {
      await expect(signOutIfDisabled(error)).resolves.toBeUndefined();
    }
    expect(calls.logout).not.toHaveBeenCalled();
    expect(calls.redirect).toHaveBeenCalledTimes(1);
  });
});
