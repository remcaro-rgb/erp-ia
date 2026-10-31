import { toolName } from "../tools/from-registry";

// The evaluation set's cases and how a model's tool call is compared with one (rule 30, design §7.1).

export type EvalTier = "core" | "extended";

/** One Spanish prompt and the tool call the assistant must make for it. */
export interface EvalCase {
  id: string;
  prompt: string;
  /** `core` cases must all pass; `extended` ones count toward the overall rate (owner 2026-10-30). */
  tier: EvalTier;
  expect: { process: string; confirmation?: boolean; input?: Record<string, unknown> };
}

export interface EvalCall {
  tool: string;
  input: unknown;
}

const show = (value: unknown): string => JSON.stringify(value);

/** Why `got` does not contain `expected` (objects and arrays as subsets, scalars exactly), or null. */
function subset(expected: unknown, got: unknown, path: string): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(got)) return `${path}: expected a list, got ${show(got)}`;
    const missing = expected.find((e) => !got.some((g) => subset(e, g, path) === null));
    return missing === undefined ? null : `${path}: no element contains ${show(missing)} (got ${show(got)})`;
  }
  if (expected !== null && typeof expected === "object") {
    if (got === null || typeof got !== "object" || Array.isArray(got)) return `${path}: expected an object, got ${show(got)}`;
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in got)) return `${path}.${key}: missing`;
      const reason = subset(value, (got as Record<string, unknown>)[key], `${path}.${key}`);
      if (reason) return reason;
    }
    return null;
  }
  return expected === got ? null : `${path}: expected ${show(expected)}, got ${show(got)}`;
}

/**
 * Null when the call is the expected one: the tool is the process's provider-safe name and the input contains every
 * field the case names (extra fields and extra list elements are fine). Otherwise the reason.
 */
export function matchCall(expect: EvalCase["expect"], got: EvalCall): string | null {
  const tool = toolName(expect.process);
  if (got.tool !== tool) return `expected tool ${tool}, got ${got.tool}`;
  return subset(expect.input ?? {}, got.input ?? {}, "input");
}
