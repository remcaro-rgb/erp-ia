import type { z } from "zod";
import type { ProcessDef } from "../registry/types";

/** The only processes that may skip the role matrix: the kernel's own user-preference processes. */
const SELF_SERVICE_PREFIX = "kernel.user_prefs.";

/**
 * Declares a process; typing the handler's input and output from the Zod schemas. Throws when a process
 * asks for `permission: "none"` and is not a kernel user-preference update or consult.
 */
export function defineProcess<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(def: ProcessDef<I, O>): ProcessDef<I, O> {
  if (def.permission === "none") {
    const allowed = def.module === "kernel" && def.id.startsWith(SELF_SERVICE_PREFIX) && (def.kind === "update" || def.kind === "consult");
    if (!allowed) {
      throw new Error(`process ${def.id}: permission "none" is reserved for kernel ${SELF_SERVICE_PREFIX}* update and consult processes`);
    }
  }
  return def;
}
