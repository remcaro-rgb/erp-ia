import type { z } from "zod";
import type { ProcessContext } from "../process/context";

export type ProcessKind = "create" | "update" | "delete" | "consult";

/**
 * A registered process: the only way state changes (design §5.4). Handlers and keys are declared as
 * methods so a process with a concrete input schema is assignable to the registry's `ProcessDef`.
 */
export interface ProcessDef<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  /** `<module>.<entity>.<verb>`, e.g. `sales.order.confirm`. */
  id: string;
  module: string;
  kind: ProcessKind;
  input: I;
  output: O;
  /** Spanish (es-419); used as the assistant's tool description. */
  description: string;
  feature?: string;
  /**
   * `step-up` always requires a fresh step-up; a company admin can require it for any other process
   * through `kernel.sensitive_processes` (admins raise sensitivity, never lower it).
   */
  sensitivity?: "normal" | "step-up";
  /** Runs with the same key in the same company return the first run's stored result. */
  idempotencyKey?(input: z.infer<I>): string;
  /** Runs in the process transaction, as the caller, under RLS. */
  handler(ctx: ProcessContext, input: z.infer<I>): Promise<z.infer<O>>;
}

/** Placeholder for the module manifest; Task 6 replaces it with the real definition. */
export interface ModuleDef {
  id: string;
}
