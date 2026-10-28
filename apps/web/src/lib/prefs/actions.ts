"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import { isThemeMode, sanitizeTabs } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";

// The shell saves the user's theme and open tabs through `kernel.user_prefs.set` (self-service, audited).
// Only these two keys are accepted from the browser, and only in their known shapes.

export type ShellPref = { key: "theme"; value: unknown } | { key: "tabs"; value: unknown };

export async function saveShellPref(pref: ShellPref): Promise<{ ok: boolean }> {
  let value: unknown;
  if (pref.key === "theme") {
    if (!isThemeMode(pref.value)) return { ok: false };
    value = pref.value;
  } else if (pref.key === "tabs") {
    value = sanitizeTabs(pref.value);
  } else {
    return { ok: false };
  }
  try {
    await runProcess(processDeps(), await requireCaller(), "kernel.user_prefs.set", { key: pref.key, value });
    return { ok: true };
  } catch (error) {
    // A preference that could not be saved stays in this browser's cache; the page goes on.
    if (error instanceof ProcessError) return { ok: false };
    throw error;
  }
}
