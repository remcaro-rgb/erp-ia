import type { JSONSchema7 } from "@ai-sdk/provider";
import type { ProcessKind } from "@erp/kernel";

/**
 * A tool the assistant is offered, as plain data: it crosses the workflow's step boundary (the turn's preparation step
 * lists the caller's tools; the workflow builds the AI SDK tools from them). `inputSchema` is plain JSON Schema, with no
 * provider-specific feature (design §7.4).
 */
export interface ToolDescriptor {
  /** Provider-safe name: a process id with `.` → `__` (`core__party__create`), or a built-in's (`data__query`). */
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  source: { type: "process"; processId: string; kind: ProcessKind } | { type: "builtin" };
}

/** Executes a tool call by tool name; what the tool returns is what the model reads. */
export type ToolRunner = (name: string, input: unknown) => Promise<unknown>;

/** A refusal handed back to the model as the tool's result, so it can explain it (never thrown: a step would retry it). */
export interface ToolRefusal {
  ok: false;
  error: { code: string; message?: string; field?: string; details?: unknown };
}

export const refusal = (code: string, extra: Omit<ToolRefusal["error"], "code"> = {}): ToolRefusal => ({ ok: false, error: { code, ...extra } });
