"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@erp/ui/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@erp/ui/components/ui/sheet";
import type { ShellModule } from "./types";

export interface MobileMenuProps {
  /** Modules the caller has at least one menu item in. */
  modules: ShellModule[];
  activeModuleId: string | undefined;
  onSelectModule: (moduleId: string) => void;
}

const row =
  "flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 text-left text-[14px] text-text hover:bg-head focus-visible:outline-2 focus-visible:outline-focus";

/**
 * Below 1024 px the side menu becomes a "Menú" sheet (shell v7, owner 2026-11-02, design §22.24, rule 19): the module names only,
 * as in the side menu. The active module's sections stay in the bar, under "Más ▾" when they do not fit.
 */
export function MobileMenu({ modules, activeModuleId, onSelectModule }: MobileMenuProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label={t("nav.shell.menu_title")}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-bar-line bg-transparent px-2.5 py-1.5 text-[13px] whitespace-nowrap text-bar-text hover:bg-bar-ctl focus-visible:outline-2 focus-visible:outline-focus lg:hidden"
      >
        <Menu className="size-4" aria-hidden="true" />
        {t("nav.shell.menu")}
      </SheetTrigger>
      <SheetContent side="left" className="w-[280px] max-w-[88vw] gap-2 overflow-y-auto bg-surface p-3 text-text">
        <SheetTitle className="px-3 pt-1 text-[15px]">{t("nav.shell.menu_title")}</SheetTitle>
        <SheetDescription className="sr-only">{t("nav.shell.side_menu")}</SheetDescription>
        <nav aria-label={t("nav.shell.modules_heading")} className="flex flex-col gap-0.5">
          <div className="px-3 pt-1 text-[11px] font-semibold tracking-[.04em] text-text-muted uppercase">{t("nav.shell.modules_heading")}</div>
          {modules.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-current={m.id === activeModuleId ? "true" : undefined}
              className={cn(row, "font-semibold", m.id === activeModuleId && "bg-accent text-link")}
              onClick={() => {
                onSelectModule(m.id);
                setOpen(false);
              }}
            >
              {t(m.label)}
            </button>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
