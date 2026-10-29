import type { CloneResult } from "./clone";

// How "Duplicar" hands the copy to the create form (rule 37): the record's data never goes into the URL. The server
// action's answer is kept in this browser tab's memory while the app moves to the create form (a client-side
// navigation, so the module stays loaded), and the form reads it through `useSyncExternalStore(subscribeClones, …)`.
//
// Lifetime: a copy waits (`handOffClone`) until a create form of its entity takes it (`takeClone`, once), stays with
// that form while it is shown, and goes when the form is saved or closed (`finishClone`) or left (`leaveClone`). The
// router keeps visited pages alive but hidden; a hidden form's effects are cleaned up, so leaving drops its copy and
// the form shown again later without a fresh "Duplicar" is empty. Sign-out and a company switch forget every copy
// (`clearCloneHandoff`). A reload starts empty. On the server there is never a copy: one module serves every request.

/** A copy on its way to the create form; `handoffId` tells one "Duplicar" from the next, even of the same source. */
export type CloneHandoff = Extract<CloneResult, { ok: true }> & { handoffId: number };

let pending: CloneHandoff | null = null;
const taken = new Map<string, CloneHandoff>();
const leaving = new Map<string, ReturnType<typeof setTimeout>>();
let handoffs = 0;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** Calls `listener` whenever a copy arrives, is taken or goes; returns the unsubscribe. */
export function subscribeClones(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Keeps the copy for the next create form of its entity (a fresh copy replaces any earlier one). */
export function handOffClone(clone: Extract<CloneResult, { ok: true }>): CloneHandoff | null {
  if (typeof window === "undefined") return null;
  const handed: CloneHandoff = { ...clone, handoffId: ++handoffs };
  pending = handed;
  changed();
  return handed;
}

/** The copy `entity`'s create form shows: a fresh one waiting for it, else the one it took. Reading takes nothing. */
export function currentClone(entity: string): CloneHandoff | null {
  if (typeof window === "undefined") return null;
  if (pending?.entity === entity) return pending;
  return taken.get(entity) ?? null;
}

/** The form is shown: it takes the copy waiting for it (once) and keeps it. */
export function takeClone(entity: string): void {
  const timer = leaving.get(entity);
  if (timer !== undefined) {
    clearTimeout(timer);
    leaving.delete(entity);
  }
  if (pending?.entity !== entity) return;
  taken.set(entity, pending);
  pending = null;
  changed();
}

/** The form was saved or closed: its copy goes now. */
export function finishClone(entity: string): void {
  const timer = leaving.get(entity);
  if (timer !== undefined) clearTimeout(timer);
  leaving.delete(entity);
  if (!taken.delete(entity)) return;
  changed();
}

/**
 * The form was hidden or unmounted: its copy goes, after the current task, so React's strict-mode re-run of the
 * form's effects (cleanup, then the effect again at once) keeps it.
 */
export function leaveClone(entity: string): void {
  if (!taken.has(entity) || leaving.has(entity)) return;
  leaving.set(
    entity,
    setTimeout(() => {
      leaving.delete(entity);
      if (taken.delete(entity)) changed();
    }, 0),
  );
}

/** Forgets every copy, waiting or taken: the session or the company changes. */
export function clearCloneHandoff(): void {
  for (const timer of leaving.values()) clearTimeout(timer);
  leaving.clear();
  const had = pending !== null || taken.size > 0;
  pending = null;
  taken.clear();
  if (had) changed();
}
