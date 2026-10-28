import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { enrolTotp, seedAuthUser, totpCode, type AuthFixture } from "../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../test-support/memory-jar";

// POST /api/auth/step-up against the real local Auth service and database. Only `next/headers` is replaced by an
// in-memory cookie jar that stands in for the browser.
const state = vi.hoisted(() => ({ jar: undefined as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));

import { POST } from "@/app/api/auth/step-up/route";
import { completeMfa, loginWithPassword } from "@/lib/auth/login";
import { MAX_ATTEMPTS, resetAttempts, stepUpKey, takeAttempt } from "@/lib/auth/limiter";

const request = (body: unknown) =>
  new Request("http://localhost/api/auth/step-up", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let fixture: AuthFixture;
let secret: string;
let jar: MemoryJar;

beforeAll(async () => {
  fixture = await seedAuthUser({ role: "admin" });
  secret = await enrolTotp(fixture);
  // A fully signed-in session: password, then the TOTP step (codes from different 30 s windows are all accepted).
  jar = new MemoryJar();
  state.jar = jar;
  const login = await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false });
  expect(login).toEqual({ ok: true, next: "/mfa/verify" });
  expect(await completeMfa(jar, { code: totpCode(secret) })).toEqual({ ok: true, next: "/" });
});

afterAll(async () => {
  await fixture.cleanup();
});

const rows = () =>
  fixture.sql<{ user_id: string; company_id: string; token: string; consumed_at: Date | null }[]>`
    select user_id, company_id, token, consumed_at from kernel.step_up_verifications where user_id = ${fixture.userId}`;

describe("POST /api/auth/step-up", () => {
  it("answers 401 to a wrong code and leaves no verification row", async () => {
    const response = await POST(request({ code: "000000" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_code" });
    expect(await rows()).toHaveLength(0);
  });

  it("answers 400 to a body without a 6-digit code", async () => {
    expect((await POST(request({ code: "12" }))).status).toBe(400);
    expect((await POST(request({}))).status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it("answers 200 with a token and records one verification for the caller in the active company", async () => {
    const response = await POST(request({ code: totpCode(secret) }));
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    expect(token).toMatch(/^[\w-]{40,}$/);

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ user_id: fixture.userId, company_id: fixture.companyIds[0], token, consumed_at: null });
  });

  it("answers 401 mfa_required to an enrolled user whose session is password-only", async () => {
    const passwordOnly = new MemoryJar();
    state.jar = passwordOnly;
    try {
      expect(await loginWithPassword(passwordOnly, { email: fixture.email, password: fixture.password, remember: false })).toEqual({ ok: true, next: "/mfa/verify" });
      const before = (await rows()).length;
      const response = await POST(request({ code: totpCode(secret) }));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "mfa_required" });
      expect(await rows()).toHaveLength(before);
    } finally {
      state.jar = jar;
    }
  });

  it("answers 429 too_many_attempts from the 11th try in the window, without asking Auth", async () => {
    const key = stepUpKey(fixture.userId);
    await resetAttempts(key);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) await takeAttempt(key);
    const before = (await rows()).length;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const response = await POST(request({ code: totpCode(secret) }));
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ code: "too_many_attempts" });
      expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("/auth/v1"))).toHaveLength(0);
      expect(await rows()).toHaveLength(before);
    } finally {
      fetchSpy.mockRestore();
      await resetAttempts(key);
    }
  });

  it("answers 401 to a request without a session", async () => {
    state.jar = new MemoryJar();
    try {
      const response = await POST(request({ code: totpCode(secret) }));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "unauthenticated" });
    } finally {
      state.jar = jar;
    }
  });
});
