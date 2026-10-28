import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The limiter's statements, captured instead of sent: the unit tests check the stored key and the purge.
const calls = vi.hoisted(() => [] as { text: string; values: unknown[] }[]);
vi.mock("@erp/kernel", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve([{ count: 1 }]);
  };
  return { getServiceDb: () => sql };
});

import { isAcceptableEmail, loginKey, MAX_EMAIL_LENGTH, resetAttempts, storedKey, takeAttempt, WINDOW_MINUTES } from "./limiter";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("login limiter (final review I2)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("accepts an e-mail of up to 254 characters and refuses a longer one", () => {
    expect(MAX_EMAIL_LENGTH).toBe(254);
    const local = "a".repeat(64);
    const at254 = `${local}@${"b".repeat(254 - local.length - 1)}`;
    expect(at254).toHaveLength(254);
    expect(isAcceptableEmail(at254)).toBe(true);
    expect(isAcceptableEmail(`${at254}c`)).toBe(false);
    expect(isAcceptableEmail("x".repeat(10_000))).toBe(false);
  });

  it("stores the sha256 of the lower-cased key, never the e-mail", async () => {
    const key = loginKey("Laura@Demo.LOCAL");
    expect(storedKey(key)).toBe(sha256("login:laura@demo.local"));
    expect(storedKey("LOGIN:LAURA@DEMO.LOCAL")).toBe(storedKey(key));
    expect(storedKey(key)).toMatch(/^[0-9a-f]{64}$/);

    await takeAttempt(key);
    await resetAttempts(key);
    const values = calls.flatMap((c) => c.values);
    expect(values).toContain(storedKey(key));
    expect(values.some((v) => typeof v === "string" && v.includes("laura@demo.local"))).toBe(false);
  });

  it("purges at most 100 windows that ended more than an hour ago on each attempt", async () => {
    await takeAttempt(loginKey("ana@demo.local"));
    expect(calls).toHaveLength(1);
    const { text, values } = calls[0]!;
    expect(text).toMatch(/delete from kernel\.auth_attempts/);
    expect(text).toMatch(/limit \$/);
    expect(values).toContain(100);
    expect(text).toMatch(/skip locked/);
    // The window ends WINDOW_MINUTES after it starts; it is purged an hour after that.
    expect(values).toContain(WINDOW_MINUTES + 60);
  });
});
