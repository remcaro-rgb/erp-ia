"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** What the caret can land on when a panel opens. */
const FOCUSABLE = "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex='0']";

/**
 * A small panel anchored to a button (`.erp-pop`: the button first, then the `.erp-pop__panel`). It opens on click with the
 * caret on its first control, closes on Escape, a click outside or when the caret leaves it, and gives the caret back to
 * its button on Escape and on `close()` (a choice that closes it). Leaving by Tab or click is not pulled back.
 */
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T | null>(null);
  const trigger = useCallback(() => ref.current?.querySelector<HTMLElement>(":scope > button") ?? null, []);
  /** Closes the panel and returns the caret to the button. */
  const close = useCallback(() => {
    setOpen(false);
    trigger()?.focus();
  }, [trigger]);
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    root?.querySelector<HTMLElement>(`.erp-pop__panel :is(${FOCUSABLE})`)?.focus();
    const onDown = (event: MouseEvent) => {
      if (root && !root.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (root && event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    root?.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      root?.removeEventListener("focusout", onFocusOut);
    };
  }, [open, close]);
  return { open, setOpen, close, ref };
}
