import type { ThemeMode } from "./types";

export const THEME_MODES: readonly ThemeMode[] = ["auto", "light", "dark"];

export const isThemeMode = (value: unknown): value is ThemeMode => typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);

/** The toggle's cycle (prototype `cycleTheme`): auto → light → dark → auto. */
export function nextTheme(mode: ThemeMode): ThemeMode {
  return mode === "auto" ? "light" : mode === "light" ? "dark" : "auto";
}

/** Puts the mode on <html>: `data-theme="light|dark"` forces it; auto removes the attribute and the system decides. */
export function applyTheme(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  if (mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

/**
 * The same as `applyTheme`, as an inline script for the server render, so the first paint already has the
 * user's theme. `mode` is validated: only the three literals can reach the script.
 */
export function themeScript(mode: ThemeMode): string {
  const safe = isThemeMode(mode) ? mode : "auto";
  return safe === "auto" ? `document.documentElement.removeAttribute("data-theme")` : `document.documentElement.setAttribute("data-theme",${JSON.stringify(safe)})`;
}
