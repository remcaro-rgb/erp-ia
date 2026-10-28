import { describe, expect, it, vi } from "vitest";

// The length guard runs before the limiter and before Auth (final review I2): neither is reached.
const limiter = vi.hoisted(() => ({ takeAttempt: vi.fn(async () => true), resetAttempts: vi.fn() }));
vi.mock("./limiter", async (original) => ({ ...(await original<typeof import("./limiter")>()), ...limiter }));
vi.mock("@/lib/supabase/server", () => ({ createSupabase: vi.fn(() => { throw new Error("Auth must not be called"); }) }));
vi.mock("@erp/kernel", () => ({ getServiceDb: () => { throw new Error("the database must not be touched"); } }));

import { loginWithPassword } from "./login";

describe("loginWithPassword", () => {
  it("answers an e-mail longer than 254 characters as invalid credentials, without counting or calling Auth", async () => {
    const jar = { getAll: () => [], get: () => undefined, set: vi.fn(), delete: vi.fn() };
    const email = `${"a".repeat(250)}@x.co`;
    expect(await loginWithPassword(jar as never, { email, password: "x", remember: false })).toEqual({ ok: false, error: "invalid_credentials" });
    expect(limiter.takeAttempt).not.toHaveBeenCalled();
    expect(jar.set).not.toHaveBeenCalled();
  });
});
