import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getServiceDb } from "@erp/kernel";
import { loginKey, MAX_ATTEMPTS, mfaKey, resetAttempts, stepUpKey, storedKey, takeAttempt } from "@/lib/auth/limiter";
import { seedAuthUser } from "../../../../test-support/auth-fixtures";

const keys: string[] = [];
const freshKey = () => {
  const key = `test:${randomUUID()}`;
  keys.push(key);
  return key;
};

afterAll(async () => {
  await getServiceDb()`delete from kernel.auth_attempts where key = any(${keys.map(storedKey)}::text[])`;
});

describe("per-account attempt limiter", () => {
  it("allows 10 attempts in the window and refuses the 11th", async () => {
    const key = freshKey();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) expect(await takeAttempt(key)).toBe(true);
    expect(await takeAttempt(key)).toBe(false);
    expect(await takeAttempt(key)).toBe(false);
  });

  it("counts each key on its own", async () => {
    const [a, b] = [freshKey(), freshKey()];
    for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) await takeAttempt(a);
    expect(await takeAttempt(a)).toBe(false);
    expect(await takeAttempt(b)).toBe(true);
  });

  it("starts a new window after 5 minutes", async () => {
    const key = freshKey();
    for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) await takeAttempt(key);
    expect(await takeAttempt(key)).toBe(false);
    await getServiceDb()`update kernel.auth_attempts set window_start = now() - interval '6 minutes' where key = ${storedKey(key)}`;
    expect(await takeAttempt(key)).toBe(true);
    const [row] = await getServiceDb()<{ count: number }[]>`select count from kernel.auth_attempts where key = ${storedKey(key)}`;
    expect(row!.count).toBe(1);
  });

  it("a success clears the counter", async () => {
    const key = freshKey();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) await takeAttempt(key);
    await resetAttempts(key);
    expect(await takeAttempt(key)).toBe(true);
    const [row] = await getServiceDb()<{ count: number }[]>`select count from kernel.auth_attempts where key = ${storedKey(key)}`;
    expect(row!.count).toBe(1);
  });

  it("keys sign-ins by the lower-cased e-mail", () => {
    expect(loginKey("  Laura@Demo.LOCAL ")).toBe("login:laura@demo.local");
  });

  it("stores the hash of the key, not the e-mail (final review I2)", async () => {
    const key = freshKey();
    await takeAttempt(key.toUpperCase());
    const rows = await getServiceDb()<{ key: string }[]>`select key from kernel.auth_attempts where key in (${key}, ${storedKey(key)})`;
    expect(rows).toEqual([{ key: storedKey(key) }]);
  });

  it("each attempt purges windows that ended more than an hour ago, and keeps the others", async () => {
    const [stale, recent, blocked] = [freshKey(), freshKey(), freshKey()];
    for (const key of [stale, recent, blocked]) await takeAttempt(key);
    const sql = getServiceDb();
    await sql`update kernel.auth_attempts set window_start = now() - interval '66 minutes' where key = ${storedKey(stale)}`;
    await sql`update kernel.auth_attempts set window_start = now() - interval '64 minutes' where key = ${storedKey(recent)}`;
    await takeAttempt(freshKey());
    const left = await sql<{ key: string }[]>`select key from kernel.auth_attempts where key = any(${[stale, recent, blocked].map(storedKey)}::text[])`;
    expect(left.map((r) => r.key).sort()).toEqual([storedKey(recent), storedKey(blocked)].sort());
  });

  it("the auth fixtures' cleanup removes the user's hashed counters (final re-review)", async () => {
    const fixture = await seedAuthUser({ role: "member" });
    const stored = [loginKey(fixture.email), mfaKey(fixture.userId), stepUpKey(fixture.userId)].map(storedKey);
    for (const key of [loginKey(fixture.email), mfaKey(fixture.userId), stepUpKey(fixture.userId)]) await takeAttempt(key);
    await fixture.cleanup();
    expect(await getServiceDb()`select key from kernel.auth_attempts where key = any(${stored}::text[])`).toHaveLength(0);
  });

  it("is invisible and unwritable to the signed-in role", async () => {
    const key = freshKey();
    await takeAttempt(key);
    const sql = getServiceDb();
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select count(*) from kernel.auth_attempts`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
