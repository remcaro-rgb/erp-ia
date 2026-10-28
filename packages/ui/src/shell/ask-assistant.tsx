"use client";

import { createContext, useContext, type ReactNode } from "react";

// A screen inside the shell can hand the assistant a message as the user's own (design §7, §19a): the home screen's accepted
// recommendation opens the drawer with "Ejecuta <proceso> con <input>" so the agent produces the usual confirmation card.
// The shell provides it; outside the shell (tests, a standalone page) asking does nothing.

type Ask = (text: string) => void;

const AskAssistantContext = createContext<Ask>(() => {});

export function AskAssistantProvider({ ask, children }: { ask: Ask; children: ReactNode }) {
  return <AskAssistantContext.Provider value={ask}>{children}</AskAssistantContext.Provider>;
}

/** Opens the assistant drawer (when closed) and sends `text` as the user's message. */
export function useAskAssistant(): Ask {
  return useContext(AskAssistantContext);
}
