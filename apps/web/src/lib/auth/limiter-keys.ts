import { createHash } from "node:crypto";

// The limiter's keys (./limiter) and the form they are stored in. Plain functions without `server-only`, so the auth
// test fixtures (integration and Playwright) clean up the same rows the app writes.

/** The longest address SMTP carries (RFC 5321 path limit): anything longer is not an account. */
export const MAX_EMAIL_LENGTH = 254;

export const loginKey = (email: string) => `login:${email.trim().toLowerCase()}`;
export const mfaKey = (userId: string) => `mfa:${userId}`;
export const stepUpKey = (userId: string) => `stepup:${userId}`;

/** Whether `email` (as typed) may be an account's address at all; the sign-in refuses it before counting otherwise. */
export const isAcceptableEmail = (email: string) => email.trim().length <= MAX_EMAIL_LENGTH;

/** The primary key a counter is stored under in `kernel.auth_attempts`: the sha256 (hex) of the lower-cased key. */
export const storedKey = (key: string) => createHash("sha256").update(key.toLowerCase()).digest("hex");
