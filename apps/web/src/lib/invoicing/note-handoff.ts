import type { NoteSource } from "@erp/ui";

// Duplicar of a note (rule 37, Task 20 fix round 1): a note is always written from its invoice, so its Duplicar hands the source note's
// concept, reason and lines to the invoice's page, which opens its «Crear nota» panel started from them. In memory, in this browser tab:
// the copy is the user's screen state, never stored. One copy per invoice; the page that shows it takes it.

const copies = new Map<string, NoteSource>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function handOffNote(invoiceId: string, source: NoteSource): void {
  copies.set(invoiceId, source);
  notify();
}

/** The copy waiting for the invoice, without taking it (useSyncExternalStore's snapshot). */
export const pendingNote = (invoiceId: string): NoteSource | null => copies.get(invoiceId) ?? null;

/** Takes the copy: the next look finds nothing. */
export function takeNote(invoiceId: string): NoteSource | null {
  const copy = copies.get(invoiceId) ?? null;
  if (copy) {
    copies.delete(invoiceId);
    notify();
  }
  return copy;
}

export function subscribeNotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
