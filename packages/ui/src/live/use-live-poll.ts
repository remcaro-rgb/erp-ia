"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveState } from "./LiveStatus";

export interface LivePollOptions<T> {
  /** What the server sent with the page. */
  initial: T;
  /** Reads the current value; a rejection is a failed read. */
  read: () => Promise<T>;
  /** Whether there is still something to follow (an import queued or running). */
  pending: (value: T) => boolean;
  intervalMs?: number;
}

/**
 * Polls while something is pending (UI density audit M1): every `intervalMs` while the browser tab is visible, paused
 * while it is hidden (and read at once when it shows again), stopped after a failed read until `resume`, never silently.
 */
export function useLivePoll<T>({ initial, read, pending, intervalMs = 3000 }: LivePollOptions<T>) {
  const [value, setValue] = useState<T>(initial);
  const [at, setAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);
  // Visible until mounted (the server render and hydration agree), then the document says.
  const [visible, setVisible] = useState(true);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  }, [read]);

  // Reads can overlap (a click while a poll is in flight): only the latest one's answer counts.
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const next = await readRef.current();
      if (mine !== latest.current) return;
      setValue(next);
      setAt(new Date());
      setFailed(false);
    } catch {
      if (mine !== latest.current) return;
      // Said on screen, with "Reanudar": a read that fails never stops the following quietly.
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const active = pending(value);
  const wasHidden = useRef(false);
  useEffect(() => {
    if (!active || failed) return;
    if (!visible) {
      wasHidden.current = true;
      return;
    }
    const delay = wasHidden.current ? 0 : intervalMs;
    wasHidden.current = false;
    const timer = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  }, [value, active, failed, visible, intervalMs, refresh]);

  const state: LiveState = failed ? "error" : !active ? "idle" : visible ? "live" : "paused";
  return { value, at, state, refresh, resume: refresh };
}
