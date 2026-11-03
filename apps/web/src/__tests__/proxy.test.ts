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
  menuHides: vi.fn<(claims: unknown, path: string) => Promise<boolean>>(async () => false),
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

vi.mock("@/lib/shell/menu-guard", () => ({ menuHides: fake.menuHides }));

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

// Menu access (entity types spec 2026-11-02 §9.2, Task 10): a hidden item's routes are refused server-side as well. A page under an item
// the company's rules hide for the caller is answered with the forbidden screen (a rewrite to /forbidden, status 403), whatever way the
// address was reached; an API path is never matched (its processes are refused by runProcess).
describe("proxy: a screen whose menu item is hidden for the caller", () => {
  beforeEach(() => {
    fake.menuHides.mockReset();
    fake.menuHides.mockResolvedValue(false);
    fake.claims = claimsOf({ aal: "aal1", mfa_enrolled: false });
  });

  it("answers the forbidden screen at the same address", async () => {
    fake.menuHides.mockResolvedValue(true);
    const response = await proxy(request("/accounting/cost-centers"));
    expect(fake.menuHides).toHaveBeenCalledWith(expect.objectContaining({ sub: USER, active_company_id: COMPANY }), "/accounting/cost-centers");
    expect(response.status).toBe(403);
    expect(new URL(response.headers.get("x-middleware-rewrite")!).pathname).toBe("/forbidden");
    expect(response.headers.get("location")).toBeNull();
  });

  it("goes on when the item is not hidden", async () => {
    const response = await proxy(request("/accounting/cost-centers"));
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("never asks for an API path or the sign-in surface", async () => {
    await proxy(request("/api/grid/core.party"));
    await proxy(request("/login"));
    expect(fake.menuHides).not.toHaveBeenCalled();
  });

  it("matches the decoded path, so a percent-encoded address cannot slip past the guard (m1)", async () => {
    fake.menuHides.mockImplementation(async (_claims, path) => path.startsWith("/r/accounting.account/"));
    const response = await proxy(request("/r/accounting%2Eaccount/0190a0a0-0000-7000-8000-000000000099"));
    expect(fake.menuHides).toHaveBeenCalledWith(expect.anything(), "/r/accounting.account/0190a0a0-0000-7000-8000-000000000099");
    expect(response.status).toBe(403);
  });

  it("answers the forbidden screen for a path that does not decode, without a lookup (m1)", async () => {
    const response = await proxy(request("/accounting/%E0%A4%A"));
    expect(fake.menuHides).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(new URL(response.headers.get("x-middleware-rewrite")!).pathname).toBe("/forbidden");
  });

  it("asks once per request and refuses a hidden page whatever headers the client sends (prefetch, RSC: forgeable, never a skip)", async () => {
    const withHeader = (name: string, value: string) => new NextRequest(new URL("/accounting/periods", "http://127.0.0.1:3100"), { headers: { [name]: value } });
    await proxy(request("/accounting/periods"));
    expect(fake.menuHides).toHaveBeenCalledTimes(1);
    fake.menuHides.mockClear();
    fake.menuHides.mockResolvedValue(true);
    for (const [name, value] of [["next-router-prefetch", "1"], ["rsc", "1"], ["sec-purpose", "prefetch"]] as const) {
      const response = await proxy(withHeader(name, value));
      expect(response.status).toBe(403);
      expect(new URL(response.headers.get("x-middleware-rewrite")!).pathname).toBe("/forbidden");
    }
    expect(fake.menuHides).toHaveBeenCalledTimes(3);
  });
});
