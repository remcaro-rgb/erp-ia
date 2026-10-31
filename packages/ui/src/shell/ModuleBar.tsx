"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
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

/** A plain left click moves inside the shell; a modified click or the middle button is the browser's (new tab, rule 21). */
export const isPlainClick = (event: ReactMouseEvent): boolean => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

interface Entry {
  id: string;
  /** i18n key of the title. */
  label: string;
  icon: string;
  href: string;
  title: string;
  kind: "home" | "grid";
  badge?: number;
  /** A group of the module's items, shown as a menu. */
  group?: NavItem;
}

/**
 * The active module's items, in the top bar right next to the module button (prototype `renderModbar`). Each item is a real
 * link (open in a new tab with ⌘/Ctrl or the middle button). The items that do not fit move, in order, into a trailing
 * "Más ▾" menu measured at runtime (owner 2026-10-31, UX-OD-1); a hidden copy of the row gives the widths.
 */
export function ModuleBar({ items, showHome, activeHref, onNavigate }: ModuleBarProps) {
  const t = useTranslations();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const entries: Entry[] = [
    ...(showHome ? [{ id: "home", label: "nav.shell.home", icon: "home", href: "/", title: t("nav.shell.home"), kind: "home" as const }] : []),
    ...items.map((item): Entry => ({ id: item.id, label: item.label, icon: item.icon, href: item.href, title: t(item.label), kind: "grid", ...(item.badge ? { badge: item.badge } : {}), ...(item.children ? { group: item } : {}) })),
  ];
  const signature = entries.map((e) => `${e.id}:${e.title}:${e.badge ?? ""}`).join("|");

  const row = useRef<HTMLElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(entries.length);
  useLayoutEffect(() => {
    const nav = row.current;
    const copy = ghost.current;
    if (!nav || !copy) return;
    const measure = () => {
      // The room for the entries is the nav's content box; the entries sit `gap` apart.
      const style = getComputedStyle(nav);
      const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const gap = parseFloat(style.columnGap) || 0;
      const available = nav.clientWidth - padding;
      const widths = [...copy.querySelectorAll<HTMLElement>("[data-entry]")].map((el) => el.offsetWidth);
      const moreWidth = copy.querySelector<HTMLElement>("[data-more]")?.offsetWidth ?? 0;
      // No layout (not rendered, or a test): everything is shown.
      if (available <= 0 || widths.every((w) => w === 0)) return setFit(widths.length || entries.length);
      if (widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, widths.length - 1) <= available) return setFit(widths.length);
      let used = 0;
      let count = 0;
      for (const width of widths) {
        if (used + width + gap + moreWidth > available) break;
        used += width + gap;
        count++;
      }
      setFit(count);
    };
    measure();
    // The web font changes the widths once it loads.
    void document.fonts?.ready.then(measure);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
    // The entries' identity and labels decide the widths.
  }, [signature]);

  const shown = entries.slice(0, fit);
  const hidden = entries.slice(fit);
  const more: NavItem | null =
    hidden.length === 0
      ? null
      : {
          id: "__more",
          label: "nav.shell.more",
          href: "#",
          icon: "list",
          children: hidden.flatMap((e): NavItem[] =>
            e.group ? (e.group.children ?? []) : [{ id: e.id, label: e.label, href: e.href, icon: e.icon }],
          ),
        };

  const link = (entry: Entry, hiddenCopy = false) => {
    const on = isActiveHref(entry.href, activeHref);
    return (
      <a
        key={entry.id}
        href={entry.href}
        data-entry={hiddenCopy ? "" : undefined}
        aria-current={on && !hiddenCopy ? "page" : undefined}
        tabIndex={hiddenCopy ? -1 : undefined}
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          onNavigate({ href: entry.href, title: entry.title, kind: entry.kind });
        }}
        className={cn(BAR_BUTTON, "inline-flex items-center", on && BAR_BUTTON_ON)}
      >
        {entry.title}
        {entry.badge ? (
          <span className="erp-modbar-badge" aria-label={t("nav.shell.badge", { count: entry.badge })}>
            {entry.badge}
          </span>
        ) : null}
      </a>
    );
  };
  const groupTrigger = (entry: Entry) => (
    <span key={entry.id} data-entry="" className={cn(BAR_BUTTON, "inline-flex h-full items-center gap-1")}>
      {entry.title}
      <ChevronDown className="size-3.5" aria-hidden="true" />
    </span>
  );

  return (
    <nav ref={row} aria-label={t("nav.shell.module_menu")} className="relative ml-1.5 hidden min-w-0 flex-1 items-stretch gap-0.5 self-stretch border-l border-bar-line pl-2.5 lg:flex">
      {shown.map((entry) =>
        entry.group ? (
          <NavGroup
            key={entry.id}
            group={entry.group}
            activeHref={activeHref}
            open={openGroup === entry.id}
            onOpenChange={(open) => setOpenGroup(open ? entry.id : null)}
            onNavigate={onNavigate}
          />
        ) : (
          link(entry)
        ),
      )}
      {more && (
        <NavGroup group={more} activeHref={activeHref} open={openGroup === "__more"} onOpenChange={(open) => setOpenGroup(open ? "__more" : null)} onNavigate={onNavigate} />
      )}
      {/* The widths of every entry and of the "Más" trigger, never seen or reached. */}
      <div ref={ghost} aria-hidden="true" className="pointer-events-none invisible absolute top-0 left-0 flex h-0 overflow-hidden whitespace-nowrap">
        {entries.map((entry) => (entry.group ? groupTrigger(entry) : link(entry, true)))}
        <span data-more="" className={cn(BAR_BUTTON, "inline-flex items-center gap-1")}>
          {t("nav.shell.more")}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </span>
      </div>
    </nav>
  );
}
