import "server-only";
import { getServiceDb } from "@erp/kernel";

// Per-account attempt limiter (design §6): at most MAX_ATTEMPTS tries per WINDOW_MINUTES for a key, counted in
// `kernel.auth_attempts` before Auth is called, cleared by a success. Auth's own limits are per IP and all our
// requests share the Next server's IP, so this is the protection of one account against guessing. Trade-off: anyone
// who knows an e-mail can lock that account's sign-in for the window; that is the accepted price of the cap.

export const MAX_ATTEMPTS = 10;
export const WINDOW_MINUTES = 5;

export const loginKey = (email: string) => `login:${email.trim().toLowerCase()}`;
export const mfaKey = (userId: string) => `mfa:${userId}`;
export const stepUpKey = (userId: string) => `stepup:${userId}`;

/**
 * Records one attempt for `key` and says whether it may go ahead (false from the 11th attempt in the window).
 * One atomic upsert: a window older than WINDOW_MINUTES restarts at 1.
 */
export async function takeAttempt(key: string): Promise<boolean> {
  const [row] = await getServiceDb()<{ count: number }[]>`
    insert into kernel.auth_attempts as a (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      window_start = case when a.window_start <= now() - make_interval(mins => ${WINDOW_MINUTES}) then now() else a.window_start end,
      count = case when a.window_start <= now() - make_interval(mins => ${WINDOW_MINUTES}) then 1 else a.count + 1 end
    returning count`;
  return row!.count <= MAX_ATTEMPTS;
}

/** A success clears the account's counter. */
export async function resetAttempts(key: string): Promise<void> {
  await getServiceDb()`delete from kernel.auth_attempts where key = ${key}`;
}
