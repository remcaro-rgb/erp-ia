import "server-only";
import { ProcessError } from "@erp/kernel";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { issuesOf } from "./issues";

/** A step's refusal as data for the screen: the process's code and its messages (a disabled user is signed out; anything else throws). */
export async function stepRefusal(error: unknown): Promise<{ ok: false; code: string; messages: string[] }> {
  await signOutIfDisabled(error);
  if (error instanceof ProcessError) return { ok: false, code: error.code, messages: issuesOf(error.details).map((i) => i.message) };
  throw error;
}
