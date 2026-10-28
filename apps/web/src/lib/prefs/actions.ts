"use server";

import { requireCaller } from "@/lib/auth/claims";
import { saveShellPref } from "./save";
import { parseShellPref } from "./validate";

// The shell saves the user's theme, open tabs and home layout with this action while the page is open; when the page goes
// away with a save still pending, the same input goes to POST /api/prefs as a beacon.

export async function saveShellPrefAction(input: { key: "theme" | "tabs" | "home_layout"; value: unknown; savedAt: number }): Promise<{ ok: boolean }> {
  const pref = parseShellPref(input);
  if (!pref) return { ok: false };
  return { ok: await saveShellPref(await requireCaller(), pref) };
}
