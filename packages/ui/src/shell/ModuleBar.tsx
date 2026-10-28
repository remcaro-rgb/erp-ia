"use client";

import { useTranslations } from "next-intl";
import { cn } from "@erp/ui/lib/utils";
import type { NavItem } from "./types";

export interface ModuleBarProps {
  /** Menu items of the active module (manifest `navigation` entries with `menu !== false`). */
  items: NavItem[];
  /** Inicio leads the bar of the base module (the first one loaded). */
  showHome: boolean;
  /** Path of the active tab; the matching item is underlined. */
  activeHref: string;
  onNavigate: (target: { href: string; title: string; kind: "home" | "grid" }) => void;
}

/** True when `href` is the item's screen or one under it (`/parties` for `/parties/123`). */
export const isActiveHref = (itemHref: string, activeHref: string): boolean =>
  itemHref === "/" ? activeHref === "/" : activeHref === itemHref || activeHref.startsWith(`${itemHref}/`);

/** The active module's items, in the top bar right next to the module button (prototype `renderModbar`). */
export function ModuleBar({ items, showHome, activeHref, onNavigate }: ModuleBarProps) {
  const t = useTranslations();
  const entries = [
    ...(showHome ? [{ id: "home", href: "/", title: t("nav.shell.home"), kind: "home" as const }] : []),
    ...items.map((item) => ({ id: item.id, href: item.href, title: t(item.label), kind: "grid" as const })),
  ];
  return (
    <nav aria-label={t("nav.shell.module_menu")} className="ml-1.5 flex items-stretch gap-0.5 self-stretch border-l border-bar-line pl-2.5">
      {entries.map((entry) => {
        const on = isActiveHref(entry.href, activeHref);
        return (
          <button
            key={entry.id}
            type="button"
            aria-current={on ? "page" : undefined}
            onClick={() => onNavigate(entry)}
            className={cn(
              "border-y-[3px] border-transparent bg-transparent px-[11px] text-[13px] whitespace-nowrap text-[#C9D6F0] hover:bg-bar-ctl hover:text-white",
              on && "border-b-[#93C5FD] font-semibold text-white",
            )}
          >
            {entry.title}
          </button>
        );
      })}
    </nav>
  );
}
