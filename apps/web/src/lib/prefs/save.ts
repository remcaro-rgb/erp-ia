import "server-only";
import { ProcessError, runProcess, type Caller } from "@erp/kernel";
import { processDeps } from "@/lib/server/runtime";
import type { ShellPrefInput } from "./validate";

/** Stores a shell preference through `kernel.user_prefs.set` (self-service, audited). False when refused. */
export async function saveShellPref(caller: Caller, pref: ShellPrefInput): Promise<boolean> {
  try {
    await runProcess(processDeps(), caller, "kernel.user_prefs.set", { key: pref.key, value: pref.stored });
    return true;
  } catch (error) {
    // A preference that could not be saved stays in this browser's cache; the page goes on.
    if (error instanceof ProcessError) return false;
    throw error;
  }
}
