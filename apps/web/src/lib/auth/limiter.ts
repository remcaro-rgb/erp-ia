import "server-only";
import { createHash } from "node:crypto";
import { getServiceDb } from "@erp/kernel";

// Per-account attempt limiter (design §6): at most MAX_ATTEMPTS tries per WINDOW_MINUTES for a key, counted in
// `kernel.auth_attempts` before Auth is called, cleared by a success. Auth's own limits are per IP and all our
// requests share the Next server's IP, so this is the protection of one account against guessing. Trade-off: anyone
// who knows an e-mail can lock that account's sign-in for the window; that is the accepted price of the cap.
//
// The sign-in form is public (final review I2): the table stores the sha256 of the lower-cased key, never the e-mail,
// so a row has a fixed size whatever is typed; an e-mail longer than MAX_EMAIL_LENGTH never reaches the limiter
// (./login answers it as invalid credentials); and every attempt purges up to PURGE_BATCH windows that ended more than
// PURGE_AFTER_MINUTES ago, so distinct e-mails cannot grow the table without bound.

export const MAX_ATTEMPTS = 10;
export const WINDOW_MINUTES = 5;
/** The longest address SMTP carries (RFC 5321 path limit): anything longer is not an account. */
export const MAX_EMAIL_LENGTH = 254;
const PURGE_AFTER_MINUTES = 60;
const PURGE_BATCH = 100;

export const loginKey = (email: string) => `login:${email.trim().toLowerCase()}`;
export const mfaKey = (userId: string) => `mfa:${userId}`;
export const stepUpKey = (userId: string) => `stepup:${userId}`;

/** Whether `email` (as typed) may be an account's address at all; the sign-in refuses it before counting otherwise. */
export const isAcceptableEmail = (email: string) => email.trim().length <= MAX_EMAIL_LENGTH;

/** The primary key a counter is stored under: the sha256 (hex) of the lower-cased key. */
export const storedKey = (key: string) => createHash("sha256").update(key.toLowerCase()).digest("hex");

/**
 * Records one attempt for `key` and says whether it may go ahead (false from the 11th attempt in the window).
 * One atomic upsert: a window older than WINDOW_MINUTES restarts at 1. The same statement deletes up to PURGE_BATCH
 * other windows that ended more than PURGE_AFTER_MINUTES ago (rows another attempt is purging are skipped).
 */
export async function takeAttempt(key: string): Promise<boolean> {
  const id = storedKey(key);
  const [row] = await getServiceDb()<{ count: number }[]>`
    with purged as (
      delete from kernel.auth_attempts
      where key in (
        select key from kernel.auth_attempts
        where key <> ${id} and window_start < now() - make_interval(mins => ${WINDOW_MINUTES + PURGE_AFTER_MINUTES})
        limit ${PURGE_BATCH}
        for update skip locked
      )
    )
    insert into kernel.auth_attempts as a (key, window_start, count) values (${id}, now(), 1)
    on conflict (key) do update set
      window_start = case when a.window_start <= now() - make_interval(mins => ${WINDOW_MINUTES}) then now() else a.window_start end,
      count = case when a.window_start <= now() - make_interval(mins => ${WINDOW_MINUTES}) then 1 else a.count + 1 end
    returning count`;
  return row!.count <= MAX_ATTEMPTS;
}

/** A success clears the account's counter. */
export async function resetAttempts(key: string): Promise<void> {
  await getServiceDb()`delete from kernel.auth_attempts where key = ${storedKey(key)}`;
}
