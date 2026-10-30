import type { z } from "zod";
import type { ProcessDef } from "../registry/types";

/**
 * The only processes that may skip the role matrix: the kernel's own self-service processes, a user's preferences and
 * their own second step of the sign-in (design §22.19).
 */
const SELF_SERVICE_PREFIXES = ["kernel.user_prefs.", "kernel.user.mfa."] as const;

/**
 * Declares a process; typing the handler's input and output from the Zod schemas. Throws when a process
 * asks for `permission: "none"` and is not a kernel self-service (user preference or own second step) update or consult.
 */
export function defineProcess<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(def: ProcessDef<I, O>): ProcessDef<I, O> {
  if (def.permission === "none") {
    const allowed = def.module === "kernel" && SELF_SERVICE_PREFIXES.some((prefix) => def.id.startsWith(prefix)) && (def.kind === "update" || def.kind === "consult");
    if (!allowed) {
      throw new Error(`process ${def.id}: permission "none" is reserved for kernel ${SELF_SERVICE_PREFIXES.map((p) => `${p}*`).join(" / ")} update and consult processes`);
    }
  }
  return def;
}
