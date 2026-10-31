"use client";

import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";

// Unsaved changes of a record form (owner 2026-10-31, design §22.21 UX-OD-4). A form with changes reports itself while it
// is mounted; the shell (which owns navigation, tabs, the company switch and the sign-out) asks before leaving it. The
// values stay in memory: nothing is written to browser storage. Outside a shell nobody listens and the form behaves as before.

export interface UnsavedState {
  dirty: boolean;
  /** Saves the form; true when it saved (a refusal or a step-up the user abandoned is false). */
  save: () => Promise<boolean>;
}

interface UnsavedContextValue {
  report: (id: string, state: UnsavedState | null) => void;
  /** Whether any form of the screen has unsaved changes (the tab and the form show "Sin guardar"). */
  hasUnsaved: boolean;
}

const UnsavedContext = createContext<UnsavedContextValue | null>(null);

export function UnsavedProvider({ value, children }: { value: UnsavedContextValue; children: ReactNode }) {
  return <UnsavedContext.Provider value={value}>{children}</UnsavedContext.Provider>;
}

/** Whether a form of the shell's screen has unsaved changes. */
export const useHasUnsaved = (): boolean => useContext(UnsavedContext)?.hasUnsaved ?? false;

/** Reports a form's changes to the shell while it is mounted; the latest `save` is always the one called. */
export function useUnsavedChanges(dirty: boolean, save: () => Promise<boolean>): void {
  const context = useContext(UnsavedContext);
  const id = useId();
  const latest = useRef(save);
  latest.current = save;
  const report = context?.report;
  useEffect(() => {
    if (!report) return;
    report(id, dirty ? { dirty, save: () => latest.current() } : null);
    return () => report(id, null);
  }, [report, id, dirty]);
}
