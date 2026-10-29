"use client";

import { createContext, useContext, type ReactNode } from "react";

// The shell's client-side navigation (the router's push behind the leave guard), for links drawn inside screens: a link to a
// record moves without reloading the page. Outside the shell (tests, a standalone page) there is none and the browser
// follows the link.

type Navigate = (href: string) => void;

const NavigateContext = createContext<Navigate | null>(null);

export function NavigateProvider({ navigate, children }: { navigate: Navigate; children: ReactNode }) {
  return <NavigateContext.Provider value={navigate}>{children}</NavigateContext.Provider>;
}

/** The shell's navigation, or null outside the shell. */
export function useNavigate(): Navigate | null {
  return useContext(NavigateContext);
}
