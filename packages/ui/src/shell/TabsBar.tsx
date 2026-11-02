"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@erp/ui/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@erp/ui/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@erp/ui/components/ui/dialog";
import { useHasUnsaved } from "../forms/unsaved-guard";
import { useTabs } from "./tabs-store";
import type { Tab } from "./types";

export interface TabsBarProps {
  /** The "+" button: opens the command palette to pick the screen of the new tab. */
  onNew: () => void;
  /** A tab was activated by the user (the shell navigates to its href). */
  onActivate?: (tab: Tab) => void;
  /** Runs `go` now, or after the screen with unsaved changes lets it (Guardar · Descartar · Cancelar). Closing the shown tab goes through it. */
  confirmLeave?: (go: () => void) => void;
}

/**
 * The open-tabs row under the top bar (design §19a, prototype `renderTabs`): a tinted band (`--tabrow`), the
 * active tab takes the page background, every tab but Inicio closes, "+" opens the palette and
 * "Cerrar todas" closes everything but Inicio after a confirmation. The tabs scroll sideways when they do not fit
 * (OD-6) and the active one is kept in view; "+" and "Cerrar todas" stay pinned at the right, outside the scroll.
 */
export function TabsBar({ onNew, onActivate, confirmLeave }: TabsBarProps) {
  const t = useTranslations("nav.shell");
  const tc = useTranslations("common");
  const { tabs, activeId, activate, close: closeNow, closeAll: closeAllNow } = useTabs();
  const unsaved = useHasUnsaved();
  // Only the shown tab can hold unsaved changes: closing it (or every tab) asks first.
  const close = (id: string) => (confirmLeave && id === activeId ? confirmLeave(() => closeNow(id)) : closeNow(id));
  const closeAll = () => (confirmLeave ? confirmLeave(closeAllNow) : closeAllNow());
  const [confirming, setConfirming] = useState(false);
  const titleOf = (tab: Tab) => (tab.kind === "home" ? t("home") : tab.title);
  const closable = tabs.filter((tab) => !tab.pinned);
  // One tab stop for the row (the active tab): ← → move between the tab titles, Enter activates, Delete closes.
  const row = useRef<HTMLElement>(null);
  const focusAfterClose = useRef<string | null>(null);
  const focusTab = (id: string) => row.current?.querySelector<HTMLButtonElement>(`[data-tab="${CSS.escape(id)}"] > button`)?.focus();
  useEffect(() => {
    if (focusAfterClose.current === null) return;
    focusTab(focusAfterClose.current);
    focusAfterClose.current = null;
  }, [tabs]);
  // The active tab is always in view (a tab opened or activated past the edge, a long row after a reload).
  useEffect(() => {
    if (activeId === null) return;
    row.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);
  // Tabs that do not fit are flagged (edge arrows that scroll, a menu that lists every tab), never left clipped in silence.
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setEdges((prev) => {
      const next = { start: el.scrollLeft > 1, end: el.scrollWidth - el.clientWidth - el.scrollLeft > 1 };
      return prev.start === next.start && prev.end === next.end ? prev : next;
    });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [tabs.length]);
  const overflowing = edges.start || edges.end;
  const scrollBy = (direction: -1 | 1) => scroller.current?.scrollBy({ left: direction * Math.max(120, scroller.current.clientWidth * 0.6), behavior: "smooth" });
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey || tabs.length === 0) return;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step !== 0) {
      event.preventDefault();
      focusTab(tabs[(index + step + tabs.length) % tabs.length]!.id);
    } else if (event.key === "Delete" && !tabs[index]!.pinned) {
      event.preventDefault();
      // The caret goes to the neighbour (the next tab, or the previous one for the last).
      focusAfterClose.current = (tabs[index + 1] ?? tabs[index - 1])?.id ?? null;
      close(tabs[index]!.id);
    }
  };

  const confirmCloseAll = () => {
    const count = closable.length;
    closeAll();
    setConfirming(false);
    toast(t("tabs.closed", { count }));
  };

  return (
    <nav
      ref={row}
      data-tabs-row=""
      aria-label={t("tabs.label")}
      className="flex h-9 shrink-0 items-stretch gap-0.5 max-md:h-12 [@media(pointer:coarse)]:h-12 border-b border-tabrow-line bg-tabrow px-3"
    >
      {overflowing && (
        <button
          type="button"
          aria-label={t("tabs.scroll_start")}
          disabled={!edges.start}
          onClick={() => scrollBy(-1)}
          className="mt-[5px] grid shrink-0 place-items-center rounded-t-md px-1 text-tabrow-text hover:bg-tabrow-hover disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
      )}
      <div ref={scroller} data-tabs-scroll="" data-overflow={overflowing ? "" : undefined} className="-mb-px flex min-w-0 items-stretch gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab, index) => {
          const on = tab.id === activeId;
          return (
            <div
              key={tab.id}
              data-tab={tab.id}
              className={cn(
                "mt-[5px] flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 border-transparent px-3.5 text-[13px] whitespace-nowrap text-tabrow-text hover:bg-tabrow-hover",
                on && "border-tabrow-line bg-page font-semibold text-text shadow-[0_1px_0_var(--bg)] hover:bg-page",
              )}
            >
              <button
                type="button"
                aria-current={on ? "page" : undefined}
                aria-keyshortcuts={tab.pinned ? undefined : "Delete"}
                tabIndex={on ? 0 : -1}
                onKeyDown={(event) => onTabKey(event, index)}
                onClick={() => {
                  activate(tab.id);
                  onActivate?.(tab);
                }}
                className="h-full rounded-sm bg-transparent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
              >
                {titleOf(tab)}
                {on && unsaved && (
                  <>
                    <i aria-hidden="true" className="erp-unsaved-dot ml-1.5" />
                    <span className="sr-only"> {tc("unsaved.tab")}</span>
                  </>
                )}
              </button>
              {!tab.pinned && (
                <button
                  type="button"
                  aria-label={t("tabs.close", { title: titleOf(tab) })}
                  // A 20 px mouse target; from the keyboard, Delete on the tab closes it (one stop per tab, not two).
                  tabIndex={-1}
                  onClick={() => close(tab.id)}
                  className="-mr-1.5 grid size-5 max-md:size-11 [@media(pointer:coarse)]:size-11 place-items-center rounded-sm text-xs opacity-60 hover:bg-tabrow-hover hover:opacity-100"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
      {overflowing && (
        <>
          <button
            type="button"
            aria-label={t("tabs.scroll_end")}
            disabled={!edges.end}
            onClick={() => scrollBy(1)}
            className="mt-[5px] grid shrink-0 place-items-center rounded-t-md px-1 text-tabrow-text hover:bg-tabrow-hover disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("tabs.list", { count: tabs.length })}
              className="mt-[5px] flex shrink-0 items-center gap-1 rounded-t-md px-2 text-xs text-tabrow-text hover:bg-tabrow-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
            >
              <span aria-hidden="true">{tabs.length}</span>
              <ChevronsUpDown className="size-3.5" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 min-w-56 overflow-y-auto">
              {tabs.map((tab) => (
                <DropdownMenuItem
                  key={tab.id}
                  aria-current={tab.id === activeId ? "page" : undefined}
                  className={cn(tab.id === activeId && "font-semibold")}
                  onSelect={() => {
                    activate(tab.id);
                    onActivate?.(tab);
                  }}
                >
                  {titleOf(tab)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      <button
        type="button"
        aria-label={t("tabs.new")}
        onClick={onNew}
        className="mt-[5px] flex shrink-0 items-center rounded-t-md px-3.5 text-base text-tabrow-text hover:bg-tabrow-hover"
      >
        +
      </button>
      {closable.length > 0 && (
        <button
          type="button"
          title={t("tabs.close_all_hint")}
          onClick={() => setConfirming(true)}
          className="ml-auto shrink-0 self-center rounded-sm border border-transparent px-2 py-1 text-xs whitespace-nowrap text-tabrow-text hover:border-tabrow-line hover:bg-tabrow-hover"
        >
          {t("tabs.close_all")} ✕
        </button>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent showCloseButton={false} className="max-w-[480px] gap-0 rounded-xl border-0 bg-surface p-0 text-text sm:max-w-[480px]">
          <DialogHeader className="border-b border-line-2 px-[18px] py-3">
            <DialogTitle className="text-[15px] font-bold">{t("tabs.close_all_title")}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="p-[18px] text-sm text-text">
            {t("tabs.close_all_body", { count: closable.length, titles: closable.map(titleOf).join(", ") })}
          </DialogDescription>
          <DialogFooter className="border-t border-line-2 bg-head px-[18px] py-3">
            <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-line bg-surface px-3 py-[7px] text-[13px] hover:bg-head">
              {tc("cancel")}
            </button>
            <button type="button" onClick={confirmCloseAll} className="rounded-md border border-primary bg-primary px-3 py-[7px] text-[13px] font-semibold text-white hover:bg-primary-h">
              {t("tabs.close_all")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </nav>
  );
}
