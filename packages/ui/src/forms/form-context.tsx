"use client";

import { createContext, useContext, type ReactNode } from "react";

// What the record forms share without prop drilling: whether the DIAN schema hints and codes are shown (OD-12), and the
// user's saved choice that the shell provides (`kernel.user_prefs`, key `forms.dian_hints`).

/** The user's preference for the DIAN hints, as the shell holds it; absent outside the shell (a form then keeps its own switch). */
export interface FormPrefs {
  dianHints: boolean;
  setDianHints: (on: boolean) => void;
}

const FormPrefsContext = createContext<FormPrefs | null>(null);
export const FormPrefsProvider = FormPrefsContext.Provider;
export const useFormPrefs = (): FormPrefs | null => useContext(FormPrefsContext);

const DianHintsContext = createContext(false);
export const DianHintsProvider = DianHintsContext.Provider;
/** Whether the DIAN schema hints and the codes before names are shown in this form. Off by default (OD-12). */
export const useDianHints = (): boolean => useContext(DianHintsContext);

/** A piece of a label or hint that is a DIAN schema annotation: shown only while "Ver códigos DIAN" is on. */
export function DianText({ children }: { children: ReactNode }) {
  return useDianHints() ? <>{children}</> : null;
}
