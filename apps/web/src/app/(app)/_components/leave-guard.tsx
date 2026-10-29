"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

// Leaving a screen with staged changes asks first (OD-7: the admin matrices stage their cells). Inside the app the
// question is asked in the page, never with confirm(): a link click is held back, and the shell's own navigation (menus,
// tabs, ⌘K) goes through `guardedNavigate`. Reloading or closing the tab can only ask through the browser
// (`beforeunload`).

type Guard = (go: () => void) => void;

/** The screen's guard while it holds staged changes (one screen at a time). */
let active: Guard | null = null;

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
  const dirty = count > 0;

  useEffect(() => {
    if (!dirty) return;
    const guard: Guard = (go) => setWaiting({ go });
    active = guard;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when returnValue is set.
      event.returnValue = "";
    };
    // Capture phase on the document: runs before the router's link handler, which then sees defaultPrevented.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      const href = `${url.pathname}${url.search}${url.hash}`;
      setWaiting({ go: () => router.push(href) });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      if (active === guard) active = null;
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, router]);

  if (!waiting || !dirty) return null;
  const stay = () => setWaiting(null);
  const leave = () => {
    const { go } = waiting;
    setWaiting(null);
    active = null;
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
