import type { StoredUserPref } from "@erp/kernel";
import { isThemeMode, sanitizeHomeLayout, sanitizeTabs, type Saved } from "@erp/ui";

// The shell's preferences as the browser may send them (server action and pagehide beacon) and as they are
// stored: `{ value, savedAt }` under the key, `savedAt` being the browser's time of the change so the shell can
// compare it with its own cache. Only the theme, the tabs, the home layout and the two on/off choices (assistant drawer, DIAN hints), in their known shapes.

export type ShellPrefKey = "theme" | "tabs" | "home_layout" | "assistant.open" | "forms.dian_hints";

export interface ShellPrefInput {
  key: ShellPrefKey;
  stored: Saved<unknown>;
}

/** A browser clock may run ahead; a day is the most we believe. */
const MAX_CLOCK_AHEAD_MS = 86_400_000;

/** The preference to store, or null when the input is not a theme or tabs change with a plausible time. */
export function parseShellPref(input: unknown, now: number = Date.now()): ShellPrefInput | null {
  if (typeof input !== "object" || input === null) return null;
  const { key, value, savedAt } = input as { key?: unknown; value?: unknown; savedAt?: unknown };
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt) || savedAt <= 0 || savedAt > now + MAX_CLOCK_AHEAD_MS) return null;
  if (key === "theme") return isThemeMode(value) ? { key, stored: { value, savedAt } } : null;
  if (key === "tabs") return { key, stored: { value: sanitizeTabs(value), savedAt } };
  if (key === "assistant.open" || key === "forms.dian_hints") return typeof value === "boolean" ? { key, stored: { value, savedAt } } : null;
  if (key === "home_layout") {
    // Stored repaired (clamped spans and heights), never as sent; a layout with an unknown widget is refused.
    const layout = sanitizeHomeLayout(value);
    return layout ? { key, stored: { value: layout, savedAt } } : null;
  }
  return null;
}

/** A stored row as `{ value, savedAt }`; a bare value (stored before the envelope) takes the row's time. */
export function savedFrom(row: StoredUserPref | undefined): Saved<unknown> | null {
  if (!row) return null;
  const stored = row.value as { value?: unknown; savedAt?: unknown } | null;
  if (stored && typeof stored === "object" && "value" in stored && typeof stored.savedAt === "number") return { value: stored.value, savedAt: stored.savedAt };
  return { value: row.value, savedAt: row.updatedAt.getTime() };
}
