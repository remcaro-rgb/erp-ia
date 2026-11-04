import type { NavItem } from "@erp/kernel";

export type { NavItem } from "@erp/kernel";

/** What an open-screen tab shows (design §19a: each grid, record or report opens in a tab). */
export type TabKind = "home" | "grid" | "record" | "report" | "admin";

export interface Tab {
  id: string;
  title: string;
  href: string;
  kind: TabKind;
  /** Pinned tabs (Inicio) cannot be closed and survive "Cerrar todas". */
  pinned?: boolean;
}

/** The open tabs of a user, as persisted in `kernel.user_prefs` (key `tabs`) and cached in localStorage. */
export interface TabsSnapshot {
  tabs: Tab[];
  activeId: string;
}

/** A saved preference and when it was saved (ms since epoch, the browser's clock), to keep the newer copy. */
export interface Saved<T> {
  value: T;
  savedAt: number;
}

/** `auto` follows `prefers-color-scheme`; the other two force a theme (`data-theme` on <html>). */
export type ThemeMode = "auto" | "light" | "dark";

export interface ShellCompany {
  id: string;
  name: string;
  taxId?: string | null;
  /** IANA time zone of the company: grids and the assistant show dates and times in it. */
  timeZone?: string;
}

export interface ShellUser {
  id: string;
  name: string;
  email: string;
  /** Role names in the active company. */
  roles: string[];
}

/** A module the caller's company is entitled to; its items are the `nav` entries whose id starts with `<id>.`. */
export interface ShellModule {
  id: string;
  /** i18n key, e.g. `nav.modules.core`. */
  label: string;
  /** `NavItem.icon` name of the module's mark in the side menu. */
  icon?: string;
}

/** One entry of the ⌘K palette: navigation, a create process, or (built by the palette) a question. */
export interface CommandItem {
  id: string;
  /** Already translated. */
  label: string;
  /** `record`: a record found by its ID (D16). */
  kind: "go" | "create" | "record";
  href: string;
  /** Extra words that find the item ("clientes" finds Terceros). */
  keywords?: string[];
}

/** The module an item belongs to: items are named `<module>.<name>` like the features that unlock them. */
export const moduleOf = (item: Pick<NavItem, "id">): string => item.id.split(".")[0]!;
