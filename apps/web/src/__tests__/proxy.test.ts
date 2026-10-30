import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The proxy's check for a removed second step (design §22.19, owner decision 2026-10-30): an access token still claims
// `mfa_enrolled` for up to its lifetime after the factor was removed (Auth signs nothing out offline). Only such a token
// costs a lookup; when the user no longer has a verified factor the session is signed out (cookies cleared) and the
// browser goes to the sign-in page with the notice. A token that says `mfa_enrolled: false` is never looked up.

const fake = vi.hoisted(() => ({
  claims: {} as Record<string, unknown>,
  signOut: vi.fn(async () => ({ error: null })),
  hasVerifiedFactor: vi.fn(async () => true),
}));

vi.mock("@/lib/supabase/server", () => ({
  clientIpOf: () => undefined,
  createSupabase: () => ({ auth: { getClaims: async () => ({ data: { claims: fake.claims }, error: null }), signOut: fake.signOut } }),
}));
vi.mock("@erp/kernel", async (original) => ({
  ...(await original<typeof import("@erp/kernel")>()),
  getServiceDb: () => ({}) as never,
  hasVerifiedFactor: fake.hasVerifiedFactor,
}));

import { proxy } from "@/proxy";

const USER = "0190a0a0-0000-7000-8000-000000000001";
const COMPANY = "0190a0a0-0000-7000-8000-0000000000c1";
const claimsOf = (extra: Record<string, unknown>) => ({
  sub: USER,
  tenant_id: "0190a0a0-0000-7000-8000-0000000000a1",
  company_ids: [COMPANY],
  active_company_id: COMPANY,
  role_ids: [],
  locale: "es-419",
  app_metadata: { active_company_id: COMPANY },
  ...extra,
});
const request = (path: string) => new NextRequest(new URL(path, "http://127.0.0.1:3100"));

describe("proxy: a session that claims a factor the user no longer has", () => {
  beforeEach(() => {
    fake.signOut.mockClear();
    fake.hasVerifiedFactor.mockReset();
  });

  it("is signed out and sent to the sign-in page with the notice when the factor is gone", async () => {
    fake.claims = claimsOf({ aal: "aal2", mfa_enrolled: true });
    fake.hasVerifiedFactor.mockResolvedValue(false);
    const response = await proxy(request("/parties"));
    expect(fake.hasVerifiedFactor).toHaveBeenCalledWith(expect.anything(), USER);
    expect(fake.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname + new URL(response.headers.get("location")!).search).toBe("/login?notice=mfa_disabled");
  });

  it("answers 401 on an API path instead of redirecting", async () => {
    fake.claims = claimsOf({ aal: "aal2", mfa_enrolled: true });
    fake.hasVerifiedFactor.mockResolvedValue(false);
    const response = await proxy(request("/api/agent/turn"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "unauthenticated", details: null });
    expect(fake.signOut).toHaveBeenCalledOnce();
  });

  it("goes on when the factor is still there", async () => {
    fake.claims = claimsOf({ aal: "aal2", mfa_enrolled: true });
    fake.hasVerifiedFactor.mockResolvedValue(true);
    const response = await proxy(request("/parties"));
    expect(response.headers.get("location")).toBeNull();
    expect(fake.signOut).not.toHaveBeenCalled();
  });

  it("never looks up a token that claims no factor (the normal case after a refresh)", async () => {
    fake.claims = claimsOf({ aal: "aal1", mfa_enrolled: false });
    const response = await proxy(request("/parties"));
    expect(fake.hasVerifiedFactor).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBeNull();
  });

  it("never looks anything up on the sign-in surface", async () => {
    fake.claims = claimsOf({ aal: "aal1", mfa_enrolled: true });
    await proxy(request("/mfa/verify"));
    expect(fake.hasVerifiedFactor).not.toHaveBeenCalled();
  });
});
