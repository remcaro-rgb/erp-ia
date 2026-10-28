import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

// Machine-to-machine secrets (the outbox tick): compared in constant time. Both sides are hashed first, so neither the
// length nor a shared prefix of the presented value leaks through the comparison's timing. An unset or empty secret
// matches nothing: a route guarded by a secret nobody configured stays closed.

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** True when `presented` equals the configured `secret` (and the secret is configured). */
export function secretMatches(presented: string | null, secret: string | undefined): boolean {
  if (!secret || presented === null) return false;
  return timingSafeEqual(digest(presented), digest(secret));
}
