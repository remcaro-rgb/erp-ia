// Saving the home layout (design §19a): each change goes through the server action at once; one that has not landed when
// the page goes away is sent as a beacon to POST /api/prefs, the path the shell uses for its tabs (a server action cannot
// outlive the page). The dashboard's own browser cache is the last resort: the next visit saves the newer copy again.

export interface LayoutPref {
  key: "home_layout";
  value: unknown;
  savedAt: number;
}

export interface LayoutSaverDeps {
  action: (pref: LayoutPref) => Promise<{ ok: boolean }>;
  beacon: (pref: LayoutPref) => void;
}

export function createLayoutSaver({ action, beacon }: LayoutSaverDeps) {
  /** The newest layout whose save has not been confirmed. */
  let pending: LayoutPref | null = null;
  return {
    async save(layout: unknown, savedAt: number): Promise<void> {
      const pref: LayoutPref = { key: "home_layout", value: layout, savedAt };
      pending = pref;
      try {
        const result = await action(pref);
        // An older save finishing after a newer one must not clear the newer one.
        if (result.ok && pending === pref) pending = null;
      } catch {
        // Still pending: the page-hide beacon or the next visit's cache retries it.
      }
    },
    /** The page is going away: sends the unconfirmed layout, if any. */
    pageHide(): void {
      const pref = pending;
      if (!pref) return;
      pending = null;
      beacon(pref);
    },
  };
}
