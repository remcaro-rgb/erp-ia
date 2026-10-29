"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { cn } from "@erp/ui/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@erp/ui/components/ui/dialog";
import { useTabs } from "./tabs-store";
import type { Tab } from "./types";

export interface TabsBarProps {
  /** The "+" button: opens the command palette to pick the screen of the new tab. */
  onNew: () => void;
  /** A tab was activated by the user (the shell navigates to its href). */
  onActivate?: (tab: Tab) => void;
}

/**
 * The open-tabs row under the top bar (design §19a, prototype `renderTabs`): a tinted band (`--tabrow`), the
 * active tab takes the page background, every tab but Inicio closes, "+" opens the palette and
 * "Cerrar todas" closes everything but Inicio after a confirmation.
 */
export function TabsBar({ onNew, onActivate }: TabsBarProps) {
  const t = useTranslations("nav.shell");
  const tc = useTranslations("common");
  const { tabs, activeId, activate, close, closeAll } = useTabs();
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
      className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-hidden border-b border-tabrow-line bg-tabrow px-3"
    >
      {tabs.map((tab, index) => {
        const on = tab.id === activeId;
        return (
          <div
            key={tab.id}
            data-tab={tab.id}
            className={cn(
              "mt-[5px] flex items-center gap-1.5 rounded-t-md border border-b-0 border-transparent px-3.5 text-[13px] whitespace-nowrap text-tabrow-text hover:bg-tabrow-hover",
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
            </button>
            {!tab.pinned && (
              <button
                type="button"
                aria-label={t("tabs.close", { title: titleOf(tab) })}
                // A 20 px mouse target; from the keyboard, Delete on the tab closes it (one stop per tab, not two).
                tabIndex={-1}
                onClick={() => close(tab.id)}
                className="-mr-1.5 grid size-5 place-items-center rounded-sm text-xs opacity-60 hover:bg-tabrow-hover hover:opacity-100"
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        aria-label={t("tabs.new")}
        onClick={onNew}
        className="mt-[5px] flex items-center rounded-t-md px-3.5 text-base text-tabrow-text hover:bg-tabrow-hover"
      >
        +
      </button>
      {closable.length > 0 && (
        <button
          type="button"
          title={t("tabs.close_all_hint")}
          onClick={() => setConfirming(true)}
          className="ml-auto self-center rounded-sm border border-transparent px-2 py-1 text-xs whitespace-nowrap text-tabrow-text hover:border-tabrow-line hover:bg-tabrow-hover"
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
