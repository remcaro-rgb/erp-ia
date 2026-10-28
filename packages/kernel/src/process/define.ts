import type { z } from "zod";
import type { ProcessDef } from "../registry/types";

/** Declares a process; typing the handler's input and output from the Zod schemas. */
export function defineProcess<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(def: ProcessDef<I, O>): ProcessDef<I, O> {
  return def;
}
