import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getServiceDb } from "@erp/kernel";
import { loginKey, MAX_ATTEMPTS, resetAttempts, takeAttempt } from "@/lib/auth/limiter";

const keys: string[] = [];
const freshKey = () => {
  const key = `test:${randomUUID()}`;
  keys.push(key);
  return key;
};

afterAll(async () => {
  await getServiceDb()`delete from kernel.auth_attempts where key = any(${keys}::text[])`;
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
    await getServiceDb()`update kernel.auth_attempts set window_start = now() - interval '6 minutes' where key = ${key}`;
    expect(await takeAttempt(key)).toBe(true);
    const [row] = await getServiceDb()<{ count: number }[]>`select count from kernel.auth_attempts where key = ${key}`;
    expect(row!.count).toBe(1);
  });

  it("a success clears the counter", async () => {
    const key = freshKey();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) await takeAttempt(key);
    await resetAttempts(key);
    expect(await takeAttempt(key)).toBe(true);
    const [row] = await getServiceDb()<{ count: number }[]>`select count from kernel.auth_attempts where key = ${key}`;
    expect(row!.count).toBe(1);
  });

  it("keys sign-ins by the lower-cased e-mail", () => {
    expect(loginKey("  Laura@Demo.LOCAL ")).toBe("login:laura@demo.local");
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
