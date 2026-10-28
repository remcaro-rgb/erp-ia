import { describe, expect, it } from "vitest";
import { mfaStep, redirectPathFor, sessionStateOf } from "./claims";

const ids = { company: "11111111-1111-4111-8111-111111111111", user: "22222222-2222-4222-8222-222222222222", tenant: "33333333-3333-4333-8333-333333333333" };
const raw = (extra: Record<string, unknown> = {}) => ({
  sub: ids.user,
  tenant_id: ids.tenant,
  company_ids: [ids.company],
  active_company_id: ids.company,
  role_ids: [],
  locale: "es-419",
  aal: "aal1",
  requires_mfa: false,
  mfa_enrolled: false,
  ...extra,
});

describe("sessionStateOf", () => {
  it("reads the kernel claims, the assurance level and the MFA flags the hook puts in the token", () => {
    expect(sessionStateOf(raw({ aal: "aal2", requires_mfa: true, mfa_enrolled: true }))).toEqual({
      claims: { sub: ids.user, tenant_id: ids.tenant, company_ids: [ids.company], active_company_id: ids.company, role_ids: [], locale: "es-419" },
      aal: "aal2",
      requiresMfa: true,
      mfaEnrolled: true,
    });
  });

  it("treats a user without a company as signed in but without kernel claims", () => {
    const state = sessionStateOf({ sub: ids.user, aal: "aal1", company_ids: [], role_ids: [], locale: "es-419" });
    expect(state).toMatchObject({ claims: null, aal: "aal1", requiresMfa: false, mfaEnrolled: false });
  });

  it("is null without a subject, and defaults the locale", () => {
    expect(sessionStateOf({})).toBeNull();
    expect(sessionStateOf(raw({ locale: undefined }))?.claims?.locale).toBe("es-419");
  });

  it("treats a missing or unknown assurance level as aal1", () => {
    expect(sessionStateOf(raw({ aal: undefined }))?.aal).toBe("aal1");
    expect(sessionStateOf(raw({ aal: "other" }))?.aal).toBe("aal1");
  });
});

describe("mfaStep", () => {
  const state = (aal: "aal1" | "aal2", requiresMfa: boolean, mfaEnrolled: boolean) => ({ claims: null, aal, requiresMfa, mfaEnrolled });

  it.each([
    ["enrolled and only password-verified", "aal1", false, true, "verify"],
    ["enrolled and role requires it, only password-verified", "aal1", true, true, "verify"],
    ["enrolled and second step done", "aal2", true, true, null],
    ["required by role but nothing enrolled", "aal1", true, false, "enroll"],
    ["not required and nothing enrolled", "aal1", false, false, null],
  ] as const)("%s", (_name, aal, requires, enrolled, expected) => {
    expect(mfaStep(state(aal, requires, enrolled))).toBe(expected);
  });
});

describe("redirectPathFor", () => {
  it("sends each failure to the page that fixes it", () => {
    expect(redirectPathFor("no_session")).toBe("/login");
    expect(redirectPathFor("mfa_required")).toBe("/mfa/verify");
    expect(redirectPathFor("mfa_enrollment_required")).toBe("/mfa/enroll");
    expect(redirectPathFor("no_company")).toBe("/login?error=no_company");
  });
});
