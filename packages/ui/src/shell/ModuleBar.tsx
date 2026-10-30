"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@erp/ui/lib/utils";
import { NavIcon } from "./nav-icons";
import type { NavItem } from "./types";

export interface ModuleBarProps {
  /** Menu items of the active module (manifest `navigation` entries with `menu !== false`); an item with `children` is a group. */
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

const BAR_BUTTON =
  "border-y-[3px] border-transparent bg-transparent px-[11px] text-[13px] whitespace-nowrap text-bar-text hover:bg-bar-ctl hover:text-white";
const BAR_BUTTON_ON = "border-b-focus font-semibold text-white";

interface GroupProps {
  group: NavItem;
  activeHref: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: ModuleBarProps["onNavigate"];
}

/** A group of the items bar: `Maestros ▾` opens a menu of its children (prototype `.dd` / `.ddm`). */
function NavGroup({ group, activeHref, open, onOpenChange, onNavigate }: GroupProps) {
  const t = useTranslations();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const entries = useRef<Array<HTMLButtonElement | null>>([]);
  const children = group.children ?? [];
  const on = children.some((child) => isActiveHref(child.href, activeHref));

  // Opening focuses the first entry; a pointer press outside the group closes it.
  useEffect(() => {
    if (!open) return;
    entries.current[0]?.focus();
    const away = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open, onOpenChange]);

  const close = (refocus: boolean) => {
    onOpenChange(false);
    if (refocus) trigger.current?.focus();
  };
  const move = (from: number, step: number) => entries.current[(from + step + children.length) % children.length]?.focus();
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = entries.current.findIndex((el) => el === document.activeElement);
    if (event.key === "Escape") close(true);
    else if (event.key === "ArrowDown") move(at, 1);
    else if (event.key === "ArrowUp") move(at, -1);
    else if (event.key === "Home") move(-1, 1);
    else if (event.key === "End") move(0, -1);
    else if (event.key === "Tab") close(false);
    else return;
    if (event.key !== "Tab") event.preventDefault();
  };

  return (
    <span ref={root} className="erp-modbar-dd">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={on ? "page" : undefined}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
        className={cn(BAR_BUTTON, "inline-flex h-full items-center gap-1", on && BAR_BUTTON_ON)}
      >
        {t(group.label)}
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" aria-label={t(group.label)} className="erp-modbar-menu" onKeyDown={onMenuKey}>
          {children.map((child, index) => (
            <button
              key={child.id}
              ref={(el) => {
                entries.current[index] = el;
              }}
              type="button"
              role="menuitem"
              aria-current={isActiveHref(child.href, activeHref) ? "page" : undefined}
              onClick={() => {
                close(false);
                onNavigate({ href: child.href, title: t(child.label), kind: "grid" });
              }}
            >
              <NavIcon name={child.icon} />
              {t(child.label)}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** The active module's items, in the top bar right next to the module button (prototype `renderModbar`). */
export function ModuleBar({ items, showHome, activeHref, onNavigate }: ModuleBarProps) {
  const t = useTranslations();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const leaf = (id: string, href: string, title: string, kind: "home" | "grid") => {
    const on = isActiveHref(href, activeHref);
    return (
      <button
        key={id}
        type="button"
        aria-current={on ? "page" : undefined}
        onClick={() => onNavigate({ href, title, kind })}
        className={cn(BAR_BUTTON, on && BAR_BUTTON_ON)}
      >
        {title}
      </button>
    );
  };
  return (
    <nav aria-label={t("nav.shell.module_menu")} className="ml-1.5 flex items-stretch gap-0.5 self-stretch border-l border-bar-line pl-2.5">
      {showHome && leaf("home", "/", t("nav.shell.home"), "home")}
      {items.map((item) =>
        item.children ? (
          <NavGroup
            key={item.id}
            group={item}
            activeHref={activeHref}
            open={openGroup === item.id}
            onOpenChange={(open) => setOpenGroup(open ? item.id : null)}
            onNavigate={onNavigate}
          />
        ) : (
          leaf(item.id, item.href, t(item.label), "grid")
        ),
      )}
    </nav>
  );
}
