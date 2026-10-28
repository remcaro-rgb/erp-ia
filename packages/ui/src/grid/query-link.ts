import { GridFilter, GridSort } from "@erp/kernel/query";
import type { SavedGridState } from "./saved-views";
import type { GridStateInput } from "./types";

// A query handed to a grid screen through the address (`/parties?q=…`): what the assistant's "Abrir como grid" opens.
// Only the parts a saved view keeps travel (filters, sort, columns); the screen validates them again on arrival and
// drops what the caller may not filter or sort on (rule 14).

/**
 * The address of the grid screen `href` with the state as its `q` parameter. The value is percent-encoded here, once, by
 * `URLSearchParams`; the page reads it with `searchParams.get`, which decodes it once, so `decodeGridQuery` receives plain JSON.
 */
export function gridQueryHref(href: string, state: GridStateInput): string {
  const { filters = [], sort = [], columns } = state;
  return `${href}?${new URLSearchParams({ q: JSON.stringify({ filters, sort, ...(columns ? { columns } : {}) }) })}`;
}

/** The saved-view state of a `q` parameter as the page reads it (already decoded: plain JSON), or null when it is not one. */
export function decodeGridQuery(value: string | null | undefined): SavedGridState | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as { filters?: unknown; sort?: unknown; columns?: unknown };
    if (typeof raw !== "object" || raw === null) return null;
    const filters = (Array.isArray(raw.filters) ? raw.filters : []).slice(0, 50).flatMap((f) => {
      const parsed = GridFilter.safeParse(f);
      return parsed.success ? [parsed.data] : [];
    });
    const sort = (Array.isArray(raw.sort) ? raw.sort : []).slice(0, 5).flatMap((s) => {
      const parsed = GridSort.safeParse(s);
      return parsed.success ? [parsed.data] : [];
    });
    const columns = Array.isArray(raw.columns) ? raw.columns.filter((c): c is string => typeof c === "string").slice(0, 200) : [];
    return { filters, sort, ...(columns.length > 0 ? { columns } : {}) };
  } catch {
    return null;
  }
}
