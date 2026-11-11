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
  /** Where Inicio leads: the active module's own Inicio page (`/inicio/<module>`); the company-wide Inicio (`/`) by default. */
  homeHref?: string;
  /** Path of the active tab; the matching item is underlined. */
  activeHref: string;
  onNavigate: (target: { href: string; title: string; kind: "home" | "grid" }) => void;
}

/** True when `href` is the item's screen or one under it (`/parties` for `/parties/123`). */
export const isActiveHref = (itemHref: string, activeHref: string): boolean =>
  itemHref === "/" ? activeHref === "/" : activeHref === itemHref || activeHref.startsWith(`${itemHref}/`);

// Shell v7 items bar (prototype `.secbtn` / `.pill`): 30 px pills on the surface, 44 px touch targets on a phone or a coarse pointer.
const BAR_BUTTON =
  "h-[30px] shrink-0 rounded-md border border-transparent bg-transparent px-[11px] text-[13px] whitespace-nowrap text-text-muted hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-focus max-md:min-h-11 [@media(pointer:coarse)]:min-h-11";
const BAR_BUTTON_ON = "border-line bg-head font-semibold text-link";

interface GroupProps {
  group: NavItem;
  activeHref: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: ModuleBarProps["onNavigate"];
}

/** The count beside a label (the pending postings of Reglas contables), read out as "N pendientes". */
function Badge({ count }: { count: number }) {
  const t = useTranslations();
  return (
    <span className="erp-modbar-badge" aria-label={t("nav.shell.badge", { count })}>
      {count}
    </span>
  );
}

/** What a group's children are waiting for in all: the group's trigger shows it, so a count inside a menu stays visible on the bar. */
const groupBadge = (group: NavItem): number => (group.children ?? []).reduce((sum, child) => sum + (child.badge ?? 0), 0);

/**
 * A group of the items bar: `Maestros ▾` opens a menu of its children (prototype `.dd` / `.ddm`). A menu section with no item says so
 * ("Aún no hay elementos en esta sección", entity types spec §9.2) instead of disappearing.
 */
function NavGroup({ group, activeHref, open, onOpenChange, onNavigate }: GroupProps) {
  const t = useTranslations();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const entries = useRef<Array<HTMLButtonElement | null>>([]);
  const menu = useRef<HTMLDivElement>(null);
  // The "Más" menu may hold an empty menu section (a child with no children): it shows its name and empty state, never an entry.
  const children = (group.children ?? []).filter((child) => !child.children);
  const emptySections = new Set((group.children ?? []).filter((child) => child.children).map((child) => child.id));
  const on = children.some((child) => isActiveHref(child.href, activeHref));
  const waiting = groupBadge(group);

  // Opening focuses the first entry (an empty section: the menu itself, so Esc still closes it); a pointer press outside the group closes it.
  useEffect(() => {
    if (!open) return;
    (entries.current[0] ?? menu.current)?.focus();
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
    else if (children.length === 0 && event.key !== "Tab") return;
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
        className={cn(BAR_BUTTON, "inline-flex items-center gap-1", on && BAR_BUTTON_ON)}
      >
        <NavIcon name={group.icon} />
        {t(group.label)}
        {waiting > 0 ? (
          <>
            {" "}
            <Badge count={waiting} />
          </>
        ) : null}
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label={t(group.label)} className="erp-modbar-menu" onKeyDown={onMenuKey} tabIndex={children.length === 0 ? -1 : undefined}>
          {children.length === 0 && emptySections.size === 0 ? <p className="erp-modbar-empty">{t("nav.section.empty")}</p> : null}
          {(group.children ?? []).map((child) => {
            if (emptySections.has(child.id)) {
              return (
                <div key={child.id} role="group" aria-label={t(child.label)} className="erp-modbar-section">
                  <p className="erp-modbar-heading">{t(child.label)}</p>
                  <p className="erp-modbar-empty">{t("nav.section.empty")}</p>
                </div>
              );
            }
            const index = children.indexOf(child);
            return (
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
                {child.badge ? (
                  <>
                    {" "}
                    <Badge count={child.badge} />
                  </>
                ) : null}
              </button>
            );
          })}
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
 * The active module's sections and items, in the items bar under the navy bar (shell v7, design §22.24; prototype `#itemsbar`), at every width. Each item is a real
 * link (open in a new tab with ⌘/Ctrl or the middle button). The items that do not fit move, in order, into a trailing
 * "Más ▾" menu measured at runtime (owner 2026-10-31, UX-OD-1); a hidden copy of the row gives the widths.
 */
export function ModuleBar({ items, showHome, homeHref = "/", activeHref, onNavigate }: ModuleBarProps) {
  const t = useTranslations();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const entries: Entry[] = [
    ...(showHome ? [{ id: "home", label: "nav.shell.home", icon: "home", href: homeHref, title: t("nav.shell.home"), kind: "home" as const }] : []),
    ...items.map((item): Entry => ({ id: item.id, label: item.label, icon: item.icon, href: item.href, title: t(item.label), kind: "grid", ...(item.badge ? { badge: item.badge } : {}), ...(item.children ? { group: item } : {}) })),
  ];
  const signature = entries.map((e) => `${e.id}:${e.title}:${e.badge ?? (e.group ? groupBadge(e.group) : "")}`).join("|");

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
          // A group's entries are listed in place of the group; an empty menu section keeps its name and empty state (spec §9.2).
          children: hidden.flatMap((e): NavItem[] =>
            e.group
              ? (e.group.children ?? []).length === 0 && e.group.section
                ? [{ ...e.group, children: [] }]
                : (e.group.children ?? [])
              : [{ id: e.id, label: e.label, href: e.href, icon: e.icon, ...(e.badge ? { badge: e.badge } : {}) }],
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
        <NavIcon name={entry.icon} />
        {entry.title}
        {entry.badge ? <Badge count={entry.badge} /> : null}
      </a>
    );
  };
  const groupTrigger = (entry: Entry) => (
    <span key={entry.id} data-entry="" className={cn(BAR_BUTTON, "inline-flex items-center gap-1")}>
      <NavIcon name={entry.icon} />
      {entry.title}
      {entry.group && groupBadge(entry.group) > 0 ? <Badge count={groupBadge(entry.group)} /> : null}
      <ChevronDown className="size-3.5" aria-hidden="true" />
    </span>
  );

  return (
    <nav ref={row} aria-label={t("nav.shell.module_menu")} className="relative flex min-w-0 flex-1 items-center gap-1 self-stretch">
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
          <NavIcon name="list" />
          {t("nav.shell.more")}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </span>
      </div>
    </nav>
  );
}
