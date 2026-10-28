"use client";

import { useState } from "react";
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

  const confirmCloseAll = () => {
    const count = closable.length;
    closeAll();
    setConfirming(false);
    toast(t("tabs.closed", { count }));
  };

  return (
    <nav
      aria-label={t("tabs.label")}
      className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-hidden border-b border-tabrow-line bg-tabrow px-3"
    >
      {tabs.map((tab) => {
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
              onClick={() => {
                activate(tab.id);
                onActivate?.(tab);
              }}
              className="h-full bg-transparent outline-none focus-visible:underline"
            >
              {titleOf(tab)}
            </button>
            {!tab.pinned && (
              <button
                type="button"
                aria-label={t("tabs.close", { title: titleOf(tab) })}
                onClick={() => close(tab.id)}
                className="text-xs opacity-50 hover:opacity-100 focus-visible:opacity-100"
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
