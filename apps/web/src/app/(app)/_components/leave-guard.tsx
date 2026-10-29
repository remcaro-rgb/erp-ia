"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

// Leaving a screen with staged changes asks first (OD-7: the admin matrices stage their cells). Inside the app the
// question is asked in the page, never with confirm(): a link click is held back, the shell's own navigation (menus,
// tabs, ⌘K) goes through `guardedNavigate`, and the browser's Back lands on a history entry the guard pushed for the
// screen (same URL), so going back first asks too. Reloading or closing the tab can only ask through the browser
// (`beforeunload`).

type Guard = (go: () => void) => void;

/** The screen's guard while it holds staged changes (one screen at a time). */
let active: Guard | null = null;

/** Marks the history entry the guard pushed: true while it guards, false once spent (reused by the next guard). */
const SENTINEL = "erpLeaveGuard";

type HistoryState = Record<string, unknown> | null;
const historyState = (): HistoryState => (window.history.state as HistoryState) ?? null;
/** The entry keeps the router's own state (Next reads it on Back/Forward); only the flag is ours. */
const withFlag = (on: boolean) => ({ ...(historyState() ?? {}), [SENTINEL]: on });

const screenOf = () => `${window.location.pathname}${window.location.search}`;

/** How long the walk back may take before its listener is dropped: each step answers within milliseconds. */
export const BACK_WALK_MS = 1000;

/**
 * Leaves the screen through the browser history: goes back `steps` entries, then on past any entry of the same screen.
 * The guard's own entry is spent but stays in the history, and a reload of the production build drops its mark (the
 * router rewrites `history.state` as the page loads), so the next guard pushes another: two entries of one screen can
 * sit side by side, and stopping on the first would leave the person where they were. The walk's `popstate` listener
 * ends once the screen is left, after BACK_WALK_MS at most, or when the answered stop function is called (the guard
 * calls it as the screen unmounts), so a later Back is never taken for part of this walk.
 */
export function goBackPast(steps: number): () => void {
  const screen = screenOf();
  let spare = 4;
  const stop = () => {
    window.clearTimeout(timer);
    window.removeEventListener("popstate", onPop);
  };
  const onPop = () => {
    if (screenOf() === screen && spare-- > 0) window.history.back();
    else stop();
  };
  const timer = window.setTimeout(stop, BACK_WALK_MS);
  window.addEventListener("popstate", onPop);
  window.history.go(-steps);
  return stop;
}

/** Runs `go` (a navigation) at once, or after the screen with staged changes lets it. */
export function guardedNavigate(go: () => void): void {
  if (active) active(go);
  else go();
}

/**
 * Guards the screen while `count` changes are staged. Answers the in-page question to render (an alertdialog with
 * "Seguir editando" and "Salir sin aplicar") while a navigation waits for it, else null.
 */
export function useLeaveGuard(count: number): ReactNode {
  const t = useTranslations();
  const router = useRouter();
  const base = useId();
  const [waiting, setWaiting] = useState<{ go: () => void } | null>(null);
  /** Set once the user chose to leave: nothing asks again on the way out. */
  const released = useRef(false);
  /** Ends the walk back past the screen (`goBackPast`) as the screen unmounts. */
  const stopWalk = useRef<(() => void) | null>(null);
  const dirty = count > 0;
  // Nothing staged any more (applied or discarded): a question still open has no reason left.
  if (!dirty && waiting) setWaiting(null);

  useEffect(() => {
    if (!dirty) return;
    released.current = false;
    const guard: Guard = (go) => setWaiting({ go });
    active = guard;

    // The entry Back leaves first: same URL, so the router stays on the screen and the guard can ask.
    if (historyState()?.[SENTINEL] === undefined) window.history.pushState(withFlag(true), "", window.location.href);
    else window.history.replaceState(withFlag(true), "", window.location.href);
    const onPopState = (event: PopStateEvent) => {
      if (released.current) return;
      const state = event.state as HistoryState;
      if (state?.[SENTINEL] !== undefined) return;
      // Back from the guard's entry: stand on it again and ask; leaving goes back past the screen.
      window.history.pushState(withFlag(true), "", window.location.href);
      setWaiting({
        go: () => {
          stopWalk.current = goBackPast(2);
        },
      });
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (released.current) return;
      event.preventDefault();
      // Older browsers ask only when returnValue is set.
      event.returnValue = "";
    };
    // Capture phase on the document: runs before the router's link handler, which then sees defaultPrevented.
    const onClick = (event: MouseEvent) => {
      if (released.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      const href = `${url.pathname}${url.search}${url.hash}`;
      setWaiting({ go: () => router.push(href) });
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      if (active === guard) active = null;
      stopWalk.current?.();
      stopWalk.current = null;
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      // Still on the guard's entry (the changes were applied or discarded): it stays, spent, for the next guard.
      if (historyState()?.[SENTINEL] === true) window.history.replaceState(withFlag(false), "", window.location.href);
    };
  }, [dirty, router]);

  if (!waiting || !dirty) return null;
  const stay = () => setWaiting(null);
  const leave = () => {
    const { go } = waiting;
    released.current = true;
    active = null;
    setWaiting(null);
    go();
  };
  return (
    <div
      role="alertdialog"
      aria-labelledby={`${base}-title`}
      aria-describedby={`${base}-body`}
      className="erp-admin__leave"
      onKeyDown={(event) => {
        if (event.key === "Escape") stay();
      }}
    >
      <b id={`${base}-title`}>{t("common.admin.leave_title")}</b>
      <span id={`${base}-body`} className="erp-small erp-muted erp-grow">
        {t("common.admin.leave_body", { count })}
      </span>
      {/* The safe answer has the focus. */}
      <button type="button" className="erp-btn erp-btn--primary" autoFocus onClick={stay}>
        {t("common.admin.leave_stay")}
      </button>
      <button type="button" className="erp-btn" onClick={leave}>
        {t("common.admin.leave_go")}
      </button>
    </div>
  );
}
