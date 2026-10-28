import { describe, expect, it } from "vitest";
import { REMEMBER_COOKIE, REMEMBER_MAX_AGE_SECONDS, rememberMode, sessionCookieOptions } from "./cookies";

describe("sessionCookieOptions", () => {
  const supabaseDefaults = { path: "/", sameSite: "lax" as const, httpOnly: false, maxAge: 400 * 24 * 60 * 60 };

  it("drops Max-Age so the cookie ends with the browser session when the user did not ask to be remembered", () => {
    const options = sessionCookieOptions(supabaseDefaults, false);
    expect(options).not.toHaveProperty("maxAge");
    expect(options).toMatchObject({ path: "/", sameSite: "lax" });
  });

  it("sets Max-Age to 30 days when the user asked to be remembered", () => {
    expect(sessionCookieOptions(supabaseDefaults, true).maxAge).toBe(30 * 24 * 60 * 60);
    expect(REMEMBER_MAX_AGE_SECONDS).toBe(2_592_000);
  });

  it("keeps a removal (Max-Age 0) a removal in both modes", () => {
    expect(sessionCookieOptions({ ...supabaseDefaults, maxAge: 0 }, false).maxAge).toBe(0);
    expect(sessionCookieOptions({ ...supabaseDefaults, maxAge: 0 }, true).maxAge).toBe(0);
  });
});

describe("rememberMode", () => {
  it("is on only when the remember cookie says 1", () => {
    const jar = (value?: string) => ({ get: (name: string) => (name === REMEMBER_COOKIE && value !== undefined ? { name, value } : undefined) });
    expect(rememberMode(jar("1"))).toBe(true);
    expect(rememberMode(jar("0"))).toBe(false);
    expect(rememberMode(jar())).toBe(false);
  });
});
