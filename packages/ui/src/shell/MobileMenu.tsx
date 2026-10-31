"use client";

import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@erp/ui/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@erp/ui/components/ui/sheet";
import { isActiveHref, isPlainClick } from "./ModuleBar";
import { NavIcon } from "./nav-icons";
import type { NavItem, ShellModule } from "./types";

export interface MobileMenuProps {
  modules: ShellModule[];
  /** Items per module id. */
  itemsByModule: Record<string, NavItem[]>;
  activeModuleId: string | undefined;
  onSelectModule: (moduleId: string) => void;
  activeHref: string;
  onNavigate: (target: { href: string; title: string; kind: "home" | "grid" }) => void;
  /** Inicio leads the list of the base module. */
  showHome: boolean;
}

const row =
  "flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 text-left text-[14px] text-text hover:bg-head focus-visible:outline-2 focus-visible:outline-focus";

/**
 * Below 1024 px the module items do not fit the bar: a "Menú" button opens a sheet with the Módulos and the active
 * module's items, the groups expanded (owner 2026-10-31, UX-OD-1). Items are links; a plain click closes the sheet.
 */
export function MobileMenu({ modules, itemsByModule, activeModuleId, onSelectModule, activeHref, onNavigate, showHome }: MobileMenuProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const items = (activeModuleId ? (itemsByModule[activeModuleId] ?? []) : []).filter((item) => item.menu !== false);
  const go = (href: string, title: string, kind: "home" | "grid") => (event: ReactMouseEvent) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    setOpen(false);
    onNavigate({ href, title, kind });
  };
  const link = (item: Pick<NavItem, "id" | "href" | "label" | "icon" | "badge">) => (
    <a
      key={item.id}
      href={item.href}
      aria-current={isActiveHref(item.href, activeHref) ? "page" : undefined}
      onClick={go(item.href, t(item.label), "grid")}
      className={cn(row, isActiveHref(item.href, activeHref) && "bg-accent font-semibold")}
    >
      <NavIcon name={item.icon} />
      {t(item.label)}
    </a>
  );
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label={t("nav.shell.menu_title")}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-bar-line bg-transparent px-2.5 py-1.5 text-[13px] whitespace-nowrap text-bar-text hover:bg-bar-ctl focus-visible:outline-2 focus-visible:outline-focus lg:hidden"
      >
        <Menu className="size-4" aria-hidden="true" />
        {t("nav.shell.menu")}
      </SheetTrigger>
      <SheetContent side="left" className="w-[88vw] max-w-sm gap-2 overflow-y-auto bg-surface p-3 text-text">
        <SheetTitle className="px-3 pt-1 text-[15px]">{t("nav.shell.menu_title")}</SheetTitle>
        <SheetDescription className="sr-only">{t("nav.shell.menu_title")}</SheetDescription>
        <nav aria-label={t("nav.shell.modules_heading")} className="flex flex-col gap-0.5">
          <div className="px-3 pt-1 text-[11px] font-semibold tracking-[.04em] text-text-muted uppercase">{t("nav.shell.modules_heading")}</div>
          {modules.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-current={m.id === activeModuleId ? "true" : undefined}
              className={cn(row, m.id === activeModuleId && "font-semibold")}
              onClick={() => {
                onSelectModule(m.id);
                setOpen(false);
              }}
            >
              {t(m.label)}
            </button>
          ))}
        </nav>
        <nav aria-label={t("nav.shell.module_menu")} className="flex flex-col gap-0.5 border-t border-line pt-2">
          {showHome && (
            <a href="/" aria-current={activeHref === "/" ? "page" : undefined} onClick={go("/", t("nav.shell.home"), "home")} className={cn(row, activeHref === "/" && "bg-accent font-semibold")}>
              {t("nav.shell.home")}
            </a>
          )}
          {items.map((item) =>
            item.children ? (
              <div key={item.id} role="group" aria-label={t(item.label)} className="mb-1 flex flex-col gap-0.5 border-b border-line pb-2">
                <div className="px-3 pt-2 text-[11px] font-semibold tracking-[.04em] text-text-muted uppercase">{t(item.label)}</div>
                {item.children.map((child) => link(child))}
              </div>
            ) : (
              link(item)
            ),
          )}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
