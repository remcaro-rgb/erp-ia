import type { SaveIssue } from "@erp/ui";

// The staged cells of an admin matrix (OD-7, design §22.11): one entry per changed cell, keyed by the screen
// (`role:process`, `entity.field:role`), applied together by a batch process with one step-up.

export type Staged<V> = Record<string, V>;

/** Stages `value` for the cell, or drops the entry when the cell is back to what is stored. */
export function stage<V>(pending: Staged<V>, key: string, value: V, stored: V): Staged<V> {
  if (value === stored) {
    if (!(key in pending)) return pending;
    const next = { ...pending };
    delete next[key];
    return next;
  }
  return { ...pending, [key]: value };
}

/** Stages several cells at once (a module's "todos / ninguno"). */
export function stageAll<V>(pending: Staged<V>, cells: { key: string; value: V; stored: V }[]): Staged<V> {
  return cells.reduce((next, cell) => stage(next, cell.key, cell.value, cell.stored), pending);
}

/** What a module's button stages for a role: everything, unless everything is already given (then nothing). */
export function moduleTarget(values: boolean[]): boolean {
  return !values.every(Boolean);
}

/** The staged cells as the batch's changes, in the order they were staged (the refusal's indexes point into it). */
export function changesOf<V, C>(pending: Staged<V>, change: (key: string, value: V) => C): C[] {
  return Object.entries(pending).map(([key, value]) => change(key, value));
}

/**
 * After new server data: the staged cells that still differ from what is stored now. `stored` answers undefined for a
 * cell the data no longer has (its role is gone), which is dropped.
 */
export function rebase<V>(pending: Staged<V>, stored: (key: string) => V | undefined): Staged<V> {
  return Object.fromEntries(
    Object.entries(pending).filter(([key, value]) => {
      const now = stored(key);
      return now !== undefined && value !== now;
    }),
  );
}

/** The index of the change a refusal names: the batch's `{ index }` (see issuesOf) or a Zod issue on `changes.<index>`. */
function indexOf(issue: SaveIssue): number | null {
  const [head, index] = issue.path ?? [];
  if (head !== "changes" || index === undefined || !/^\d+$/.test(index)) return null;
  return Number(index);
}

/** The cells of a refused batch (key → reason); `keys` are the staged keys in the order they were sent. */
export function refusedCells(keys: string[], details: SaveIssue[]): Record<string, string> {
  const cells: Record<string, string> = {};
  for (const issue of details) {
    const index = indexOf(issue);
    const key = index === null ? undefined : keys[index];
    if (key !== undefined) cells[key] = cells[key] ? `${cells[key]} · ${issue.message}` : issue.message;
  }
  return cells;
}
