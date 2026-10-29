import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enrolTotp, seedAuthUser, totpCode, type AuthFixture } from "../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));

import { completeMfa, confirmEnrolment, loginWithPassword, startEnrolment } from "@/lib/auth/login";
import { getCallerClaims, Unauthenticated } from "@/lib/auth/claims";
import { createSupabase } from "@/lib/supabase/server";
import { loginKey, MAX_ATTEMPTS, resetAttempts, storedKey, takeAttempt } from "@/lib/auth/limiter";
import { REMEMBER_COOKIE, REMEMBER_EMAIL_COOKIE, REMEMBER_MAX_AGE_SECONDS } from "@/lib/supabase/cookies";

const THIRTY_DAYS = 30 * 24 * 60 * 60;
const sessionCookies = (jar: MemoryJar) => [...jar.written].filter(([name, c]) => /^sb-.*-auth-token/.test(name) && c.value !== "");

const loginAudit = (fixture: AuthFixture) =>
  fixture.sql<{ origin: string; entity: string; row_id: string; actor_user_id: string; company_id: string; input: unknown }[]>`
    select origin, entity, row_id, actor_user_id, company_id, input from kernel.audit_log
    where process_id = 'auth.login' and row_id = ${fixture.userId} order by occurred_at`;

describe("login of a member (no MFA required)", () => {
  afterEach(() => vi.restoreAllMocks());
  let fixture: AuthFixture;
  beforeAll(async () => {
    fixture = await seedAuthUser({ role: "member" });
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  it("login with remember=false sets a session cookie without Max-Age; with remember=true sets Max-Age 30 days", async () => {
    const session = new MemoryJar();
    expect(await loginWithPassword(session, { email: fixture.email, password: fixture.password, remember: false })).toEqual({ ok: true, next: "/" });
    const sessionOnly = sessionCookies(session);
    expect(sessionOnly.length).toBeGreaterThan(0);
    for (const [, cookie] of sessionOnly) expect(cookie.options.maxAge).toBeUndefined();
    expect(session.get(REMEMBER_COOKIE)).toBeUndefined();
    expect(session.get(REMEMBER_EMAIL_COOKIE)).toBeUndefined();

    const remembered = new MemoryJar();
    expect(await loginWithPassword(remembered, { email: fixture.email, password: fixture.password, remember: true })).toEqual({ ok: true, next: "/" });
    const persistent = sessionCookies(remembered);
    expect(persistent.length).toBeGreaterThan(0);
    for (const [, cookie] of persistent) expect(cookie.options.maxAge).toBe(THIRTY_DAYS);
    expect(REMEMBER_MAX_AGE_SECONDS).toBe(THIRTY_DAYS);
    // The e-mail is prefilled next time from a cookie, not from localStorage.
    expect(remembered.get(REMEMBER_EMAIL_COOKIE)?.value).toBe(fixture.email);
    expect(remembered.written.get(REMEMBER_EMAIL_COOKIE)?.options).toMatchObject({ maxAge: THIRTY_DAYS, httpOnly: true });
  });

  it("keeps the mode when the session is refreshed later: the renewed cookies follow the remember cookie", async () => {
    for (const remember of [true, false]) {
      const jar = new MemoryJar();
      await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember });
      jar.written.clear();
      // A refresh from the proxy or a route handler knows the mode only from the jar.
      const refreshed = await createSupabase(jar).auth.refreshSession();
      expect(refreshed.error).toBeNull();
      const renewed = sessionCookies(jar);
      expect(renewed.length).toBeGreaterThan(0);
      for (const [, cookie] of renewed) expect(cookie.options.maxAge).toBe(remember ? THIRTY_DAYS : undefined);
    }
  });

  it("writes the auth.login audit row with origin ui and the mode used", async () => {
    const before = (await loginAudit(fixture)).length;
    await loginWithPassword(new MemoryJar(), { email: fixture.email, password: fixture.password, remember: true });
    const rows = await loginAudit(fixture);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      origin: "ui",
      entity: "kernel.users",
      row_id: fixture.userId,
      actor_user_id: fixture.userId,
      company_id: fixture.companyIds[0],
      input: { remember: true, mfa: "none" },
    });
  });

  it("refuses a wrong password without writing a session", async () => {
    const jar = new MemoryJar();
    expect(await loginWithPassword(jar, { email: fixture.email, password: "wrong", remember: true })).toEqual({ ok: false, error: "invalid_credentials" });
    expect(sessionCookies(jar)).toHaveLength(0);
    expect(jar.get(REMEMBER_EMAIL_COOKIE)).toBeUndefined();
  });

  it("refuses the 11th attempt in the window as too_many_attempts without calling Auth, and a success clears the count", async () => {
    const key = loginKey(fixture.email);
    await resetAttempts(key);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) await takeAttempt(key);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const jar = new MemoryJar();
    expect(await loginWithPassword(jar, { email: fixture.email.toUpperCase(), password: fixture.password, remember: false })).toEqual({ ok: false, error: "too_many_attempts" });
    expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("/auth/v1"))).toHaveLength(0);
    expect(sessionCookies(jar)).toHaveLength(0);

    // A later window, a wrong password counts, the right one clears.
    await resetAttempts(key);
    expect(await loginWithPassword(jar, { email: fixture.email, password: "wrong", remember: false })).toEqual({ ok: false, error: "invalid_credentials" });
    const [counted] = await fixture.sql<{ count: number }[]>`select count from kernel.auth_attempts where key = ${storedKey(key)}`;
    expect(counted!.count).toBe(1);
    expect(await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false })).toEqual({ ok: true, next: "/" });
    expect(await fixture.sql`select 1 from kernel.auth_attempts where key = ${storedKey(key)}`).toHaveLength(0);
  });

  it("forwards the client IP to Auth on the sign-in call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await loginWithPassword(new MemoryJar(), { email: fixture.email, password: fixture.password, remember: false, clientIp: "203.0.113.7" });
    const signIn = fetchSpy.mock.calls.find(([input]) => String(input).includes("/auth/v1/token"));
    const headers = new Headers((signIn![1] as RequestInit).headers);
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(headers.get("sb-forwarded-for")).toBe("203.0.113.7");
  });

  it("gives the session no access to getCallerClaims once the cookies are gone", async () => {
    state.jar = new MemoryJar();
    await expect(getCallerClaims()).rejects.toBeInstanceOf(Unauthenticated);
  });
});

describe("login of an admin (MFA required by role)", () => {
  let fixture: AuthFixture;
  let secret = "";
  beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  it("sends an admin without a TOTP factor to enrolment, blocks API access, then enrols and signs in", async () => {
    const jar = new MemoryJar();
    state.jar = jar;
    expect(await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false })).toEqual({ ok: true, next: "/mfa/enroll" });
    // The password alone does not open the app: the audit row of a login comes with the second step.
    await expect(getCallerClaims()).rejects.toMatchObject({ reason: "mfa_enrollment_required" });
    expect(await loginAudit(fixture)).toHaveLength(0);

    const started = await startEnrolment(jar);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    secret = started.secret;
    expect(started.qrCode).toMatch(/^data:image\/svg\+xml/);
    expect(await confirmEnrolment(jar, { factorId: started.factorId, code: "000000" })).toEqual({ ok: false, error: "invalid_code" });
    expect(await confirmEnrolment(jar, { factorId: started.factorId, code: totpCode(started.secret) })).toEqual({ ok: true, next: "/" });

    expect((await getCallerClaims()).sub).toBe(fixture.userId);
    expect((await loginAudit(fixture)).at(-1)).toMatchObject({ origin: "ui", input: { remember: false, mfa: "totp" } });
  });

  it("sends an admin with a TOTP factor to the verify step until the code is right", async () => {
    // The previous test left a verified factor; a new sign-in is at aal1 and must pass the second step.
    const jar = new MemoryJar();
    state.jar = jar;
    expect(await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: true })).toEqual({ ok: true, next: "/mfa/verify" });
    await expect(getCallerClaims()).rejects.toMatchObject({ reason: "mfa_required" });
    expect(await completeMfa(jar, { code: "000000" })).toEqual({ ok: false, error: "invalid_code" });
    await expect(getCallerClaims()).rejects.toMatchObject({ reason: "mfa_required" });
    expect(await completeMfa(jar, { code: totpCode(secret) })).toEqual({ ok: true, next: "/" });
    expect((await getCallerClaims()).sub).toBe(fixture.userId);
  });

  it("does not let a password-only session add a TOTP factor of its own to an account that has one", async () => {
    const jar = new MemoryJar();
    state.jar = jar;
    expect(await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false })).toEqual({ ok: true, next: "/mfa/verify" });
    expect(await startEnrolment(jar)).toEqual({ ok: false, error: "mfa_required" });
    const factors = await fixture.sql`select 1 from auth.mfa_factors where user_id = ${fixture.userId}`;
    expect(factors).toHaveLength(1);
  });
});

describe("a user who enrolled TOTP is asked for it whatever their role", () => {
  let fixture: AuthFixture;
  let secret: string;
  beforeAll(async () => {
    fixture = await seedAuthUser({ role: "member" });
    secret = await enrolTotp(fixture);
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  it("verify step, then the audit row records mfa totp and the mode", async () => {
    const jar = new MemoryJar();
    state.jar = jar;
    expect(await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: true })).toEqual({ ok: true, next: "/mfa/verify" });
    expect(await loginAudit(fixture)).toHaveLength(0);
    expect(await completeMfa(jar, { code: totpCode(secret) })).toEqual({ ok: true, next: "/" });
    expect((await loginAudit(fixture)).at(-1)).toMatchObject({ origin: "ui", input: { remember: true, mfa: "totp" } });
    // The second step's session keeps the 30-day mode.
    for (const [, cookie] of sessionCookies(jar)) expect(cookie.options.maxAge).toBe(THIRTY_DAYS);
  });
});

describe("a member whose membership in the company is inactive (kernel.admin.user.update active=false)", () => {
  let fixture: AuthFixture;
  let secret: string;
  const setActive = (active: boolean) => fixture.sql`update kernel.memberships set is_active = ${active} where user_id = ${fixture.userId}`;
  beforeAll(async () => {
    fixture = await seedAuthUser({ role: "member" });
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  it("is refused at the password step with account_disabled, without a session or a login audit row", async () => {
    await setActive(false);
    try {
      const jar = new MemoryJar();
      state.jar = jar;
      expect(await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: true })).toEqual({ ok: false, error: "account_disabled" });
      expect(sessionCookies(jar)).toHaveLength(0);
      await expect(getCallerClaims()).rejects.toBeInstanceOf(Unauthenticated);
      expect(await loginAudit(fixture)).toHaveLength(0);
    } finally {
      await setActive(true);
    }
    // Reactivated, the same credentials open the session again.
    expect(await loginWithPassword(new MemoryJar(), { email: fixture.email, password: fixture.password, remember: false })).toEqual({ ok: true, next: "/" });
  });

  it("is refused at the second step too when the membership was deactivated in between", async () => {
    secret = await enrolTotp(fixture);
    const jar = new MemoryJar();
    state.jar = jar;
    expect(await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false })).toEqual({ ok: true, next: "/mfa/verify" });
    await setActive(false);
    try {
      expect(await completeMfa(jar, { code: totpCode(secret) })).toEqual({ ok: false, error: "account_disabled" });
      expect(sessionCookies(jar).filter(([, c]) => c.value !== "")).toHaveLength(0);
    } finally {
      await setActive(true);
    }
  });
});
