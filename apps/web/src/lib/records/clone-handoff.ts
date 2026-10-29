import type { CloneResult } from "./clone";

// How "Duplicar" hands the copy to the create form (rule 37): the record's data never goes into the URL. The server
// action's answer is kept in this browser tab's memory while the app moves to `/r/<entity>/new` (a client-side
// navigation, so the module stays loaded); the create form takes it when it is shown. The router keeps visited pages
// alive (hidden), so a create form already open adopts a newer copy when it is shown again: it subscribes to this
// store (`useSyncExternalStore`), and a hidden page resubscribes and reads the copy when it is shown. A reload of
// `/r/<entity>/new` starts an empty form. On the server there is never a copy: one module serves every request.

/** A copy on its way to the create form; `handoffId` tells one "Duplicar" from the next, even of the same source. */
export type CloneHandoff = Extract<CloneResult, { ok: true }> & { handoffId: number };

let pending: CloneHandoff | null = null;
let handoffs = 0;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** Calls `listener` whenever the waiting copy changes; returns the unsubscribe. */
export function subscribeClones(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Keeps the copy for the create form of its entity (replacing any earlier one). */
export function handOffClone(clone: Extract<CloneResult, { ok: true }>): CloneHandoff | null {
  if (typeof window === "undefined") return null;
  pending = { ...clone, handoffId: ++handoffs };
  const handed = pending;
  changed();
  return handed;
}

/** The copy waiting for `entity`'s create form, if any. Reading does not take it (React may render twice first). */
export function pendingClone(entity: string): CloneHandoff | null {
  if (typeof window === "undefined") return null;
  return pending?.entity === entity ? pending : null;
}

/** The form took the copy (or was saved): only `clone` itself goes, so a newer copy is kept. */
export function releaseClone(clone: CloneHandoff | null): void {
  if (!clone || pending !== clone) return;
  pending = null;
  changed();
}
