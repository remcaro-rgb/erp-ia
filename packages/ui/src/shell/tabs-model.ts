import { readCachedPref } from "./prefs-cache";
import type { Saved, Tab, TabKind, TabsSnapshot } from "./types";

// The pure part of the tabs (no React): constants, the repair of a saved state and the localStorage cache.
// Server code (the save action) uses it too, so it carries no "use client".

export const HOME_TAB_ID = "home";
export const HOME_TAB: Tab = { id: HOME_TAB_ID, title: "home", href: "/", kind: "home", pinned: true };
const KINDS: readonly TabKind[] = ["home", "grid", "record", "report", "admin"];
/** More than this many tabs is a runaway, not a workspace: the oldest unpinned ones go. */
export const MAX_TABS = 30;

export const tabsStorageKey = (userId: string): string => `erp.tabs.${userId}`;

const isTab = (value: unknown): value is Tab => {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return typeof t.id === "string" && typeof t.title === "string" && typeof t.href === "string" && t.href.startsWith("/") && !t.href.startsWith("//") && KINDS.includes(t.kind as TabKind);
};

/** A trustworthy snapshot from anything read back (server prefs, localStorage): never throws. */
export function sanitizeTabs(value: unknown): TabsSnapshot {
  const raw = typeof value === "object" && value !== null ? (value as { tabs?: unknown; activeId?: unknown }) : {};
  const seen = new Set<string>(["/"]);
  const tabs: Tab[] = [HOME_TAB];
  for (const tab of Array.isArray(raw.tabs) ? raw.tabs : []) {
    if (!isTab(tab) || tab.kind === "home" || seen.has(tab.href) || tabs.some((t) => t.id === tab.id)) continue;
    seen.add(tab.href);
    tabs.push({ id: tab.id, title: tab.title, href: tab.href, kind: tab.kind, ...(tab.pinned ? { pinned: true } : {}) });
  }
  const trimmed = tabs.length > MAX_TABS ? [HOME_TAB, ...tabs.slice(tabs.length - MAX_TABS + 1)] : tabs;
  const activeId = typeof raw.activeId === "string" && trimmed.some((t) => t.id === raw.activeId) ? raw.activeId : HOME_TAB_ID;
  return { tabs: trimmed, activeId };
}

/** The cached tabs of `userId` in `companyId`, with when they were saved, or null (none, or unreadable). */
export function loadCachedTabs(storage: Storage | null | undefined, userId: string, companyId: string): Saved<TabsSnapshot> | null {
  const cached = readCachedPref(storage, tabsStorageKey(userId), companyId);
  return cached ? { value: sanitizeTabs(cached.value), savedAt: cached.savedAt } : null;
}
