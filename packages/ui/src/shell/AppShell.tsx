"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useStore } from "zustand";
import { Toaster } from "@erp/ui/components/ui/sonner";
import { AssistantDrawer, screenOf, type ResultColumn } from "../assistant";
import { CellFormatProvider } from "../grid/cell-format";
import { ExportJobsProvider } from "../grid/export-jobs";
import { gridQueryHref } from "../grid/query-link";
import type { GridStateInput } from "../grid/types";
import { CommandPalette } from "./CommandPalette";
import { isActiveHref } from "./ModuleBar";
import { TabsBar } from "./TabsBar";
import { AskAssistantProvider } from "./ask-assistant";
import { NavigateProvider } from "./navigate";
import { assistantOpenStorageKey, browserStorage, newerSaved, readCachedPref, themeStorageKey, writeCachedPref } from "./prefs-cache";
import { createTabsStore, loadCachedTabs, TabsProvider, type TabsStore } from "./tabs-store";
import { applyTheme, isThemeMode } from "./theme";
import { TopBar } from "./TopBar";
import { moduleOf, type CommandItem, type NavItem, type Saved, type ShellCompany, type ShellModule, type ShellUser, type TabKind, type TabsSnapshot, type ThemeMode } from "./types";

export interface AssistantOptions {
  /** The grid screen of an entity (`core.party` → `/parties`), when it has one: "Abrir como grid" opens it with the query. */
  gridHref?: (entity: string) => string | undefined;
  /** Labels and types of an entity's fields, for the result tables. */
  columnsOf?: (entity: string) => ResultColumn[] | undefined;
  /** The company's time zone (defaults to the company's own `timeZone`). */
  timeZone?: string;
}

export interface AppShellProps {
  company: ShellCompany;
  /** Every company of the user (the switcher). */
  companies: ShellCompany[];
  user: ShellUser;
  /** Modules the company is entitled to, in load order (the first is the base module and carries Inicio). */
  modules: ShellModule[];
  /** Menu items the caller may open: entitled and permitted (labels are i18n keys). */
  nav: NavItem[];
  /** Create processes the caller may run, for ⌘K (translated). */
  commands?: CommandItem[];
  /** What the app tells the assistant drawer about its screens. */
  assistantOptions?: AssistantOptions;
  children: ReactNode;
  /** Path of the page being shown (no query). */
  currentHref: string;
  /** Client-side navigation (the app's router). */
  navigate: (href: string) => void;
  /** The user's saved theme in this company (`kernel.user_prefs`, key `theme`), or null. */
  theme?: Saved<ThemeMode> | null;
  /** A theme change with its time, to save it (the shell already caches it in localStorage). */
  onThemeChange?: (mode: ThemeMode, savedAt: number) => void;
  /** The user's saved choice of showing the assistant drawer (`kernel.user_prefs`, key `assistant.open`), or null: then the viewport decides. */
  assistantOpen?: Saved<boolean> | null;
  /** The user opened or closed the drawer, with the time, to save it (the shell already caches it in localStorage). */
  onAssistantOpenChange?: (open: boolean, savedAt: number) => void;
  /** The user's saved tabs in this company (`kernel.user_prefs`, key `tabs`), or null. */
  initialTabs?: Saved<unknown> | null;
  /** Every change of the tabs with its time, to save them (the shell already caches them in localStorage). */
  onTabsChange?: (snapshot: TabsSnapshot, savedAt: number) => void;
  onSwitchCompany?: (companyId: string) => void;
  signOutAction?: () => void | Promise<void>;
  /** The preference cache; the browser's localStorage by default. */
  storage?: Storage | null;
}

/** Below this viewport width the assistant drawer starts closed (OD-10: it would leave the page under ~920 px at 1366). */
const ASSISTANT_MIN_WIDTH = 1280;

/** Grid and admin routes use the tighter page padding (OD-1); the home and the record page keep v5's. */
const denseRoute = (href: string): boolean => href !== "/" && !href.startsWith("/r/");

function readBooleanPref(storage: Storage | null, key: string, companyId: string): Saved<boolean> | null {
  const cached = readCachedPref(storage, key, companyId);
  return cached && typeof cached.value === "boolean" ? { value: cached.value, savedAt: cached.savedAt } : null;
}

/**
 * The application shell (design §19a, prototype v5): navy top bar with the module items, the tinted tabs row,
 * the page, the assistant drawer (400 px) and the ⌘K palette. Tabs follow the URL: opening a page opens or
 * activates its tab; activating or closing a tab navigates. Tabs and theme are per user and company: switching
 * company mounts a fresh shell that starts from the new company's saved preferences.
 */
export function AppShell(props: AppShellProps) {
  return <ShellFrame key={`${props.user.id}:${props.company.id}`} {...props} />;
}

function ShellFrame(props: AppShellProps) {
  const { company, companies, user, modules, nav, commands = [], currentHref, navigate } = props;
  const t = useTranslations();
  const [storage] = useState<Storage | null>(() => (props.storage === undefined ? browserStorage() : props.storage));

  // Callbacks change identity on every render of the parent; the store and effects read the latest.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const [store] = useState<TabsStore>(() =>
    createTabsStore({
      userId: user.id,
      companyId: company.id,
      storage,
      initial: props.initialTabs?.value,
      onChange: (snapshot, savedAt) => latest.current.onTabsChange?.(snapshot, savedAt),
    }),
  );

  const [theme, setTheme] = useState<ThemeMode>(props.theme?.value ?? "auto");
  useEffect(() => applyTheme(theme), [theme]);
  const changeTheme = useCallback(
    (mode: ThemeMode, savedAt: number = Date.now()) => {
      setTheme(mode);
      writeCachedPref(storage, themeStorageKey(user.id), company.id, { value: mode, savedAt });
      latest.current.onThemeChange?.(mode, savedAt);
    },
    [storage, user.id, company.id],
  );

  // Once mounted (the server render used the server's copies): this browser's cache wins when it is newer, e.g. a
  // change made just before the page closed that never reached the server. The newer copy is then saved.
  useEffect(() => {
    const tabs = newerSaved(props.initialTabs ?? null, loadCachedTabs(storage, user.id, company.id));
    if (tabs && tabs !== props.initialTabs) store.getState().hydrate(tabs.value);
    const cachedTheme = readCachedPref(storage, themeStorageKey(user.id), company.id);
    const themeCopy = newerSaved(props.theme ?? null, cachedTheme && isThemeMode(cachedTheme.value) ? { value: cachedTheme.value, savedAt: cachedTheme.savedAt } : null);
    if (themeCopy && themeCopy !== props.theme) changeTheme(themeCopy.value, themeCopy.savedAt);
    // Once per mounted shell: the first render's saved copies decide.
  }, [store]);

  const itemsByModule = useMemo(() => {
    const map: Record<string, NavItem[]> = {};
    for (const item of nav) (map[moduleOf(item)] ??= []).push(item);
    return map;
  }, [nav]);
  const visibleModules = useMemo(() => modules.filter((m) => (itemsByModule[m.id]?.length ?? 0) > 0), [modules, itemsByModule]);

  // A tab the user activated or closed into: go to its page. The path is read before the page effect below,
  // so the tab the page itself opens never triggers a second navigation.
  const current = useRef(currentHref);
  useEffect(() => {
    current.current = currentHref;
  }, [currentHref]);
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (state.activeId === previous.activeId) return;
        const tab = state.tabs.find((x) => x.id === state.activeId);
        if (tab && tab.href !== current.current) latest.current.navigate(tab.href);
      }),
    [store],
  );

  // The page decides the tab: a menu screen, a record, Inicio, or any other path.
  useEffect(() => {
    const item = nav.find((i) => i.href === currentHref);
    const kind: TabKind = currentHref === "/" ? "home" : currentHref.startsWith("/r/") ? "record" : "grid";
    const title = item ? t(item.label) : kind === "record" ? t("nav.shell.record") : currentHref;
    store.getState().open({ title, href: currentHref, kind });
  }, [currentHref, nav, store, t]);

  const [selectedModule, setSelectedModule] = useState<string | undefined>(undefined);
  const hrefModule = nav.find((i) => isActiveHref(i.href, currentHref));
  const activeModuleId = (hrefModule ? moduleOf(hrefModule) : undefined) ?? selectedModule ?? visibleModules[0]?.id;
  useEffect(() => setSelectedModule(undefined), [currentHref]);

  const selectModule = (moduleId: string) => {
    setSelectedModule(moduleId);
    const items = (itemsByModule[moduleId] ?? []).filter((i) => i.menu !== false);
    const hasTab = store.getState().tabs.some((tab) => items.some((i) => isActiveHref(i.href, tab.href)));
    if (items[0] && !hasTab) navigate(items[0].href);
  };

  const [paletteOpen, setPaletteOpen] = useState(false);
  // The drawer: the user's saved choice when there is one (the server's copy, or this browser's when it is newer), else
  // closed below 1280 px (OD-10). Decided once, on the first mount; the server render and hydration use the saved choice
  // or "open", and a narrow viewport closes it before the first paint. A resize afterwards never moves it.
  // With no saved choice the drawer renders in the CSS-first `auto` state (hidden under 1280 px by a media query), so the
  // first paint is right and nothing collapses after hydration; the effect then writes the same state explicitly.
  const [assistantOpen, setAssistantOpen] = useState(props.assistantOpen?.value ?? true);
  const [assistantAuto, setAssistantAuto] = useState(props.assistantOpen == null);
  useLayoutEffect(() => {
    const saved = newerSaved(props.assistantOpen ?? null, readBooleanPref(storage, assistantOpenStorageKey(user.id), company.id));
    setAssistantAuto(false);
    setAssistantOpen(saved ? saved.value : window.innerWidth >= ASSISTANT_MIN_WIDTH);
    // Once per mounted shell: the first render's saved copies and viewport decide.
  }, []);
  /** A toggle by the user: remembered for the next visit. (Opening it to answer ⌘K is not a choice and is not saved.) */
  const chooseAssistant = useCallback(
    (open: boolean) => {
      setAssistantAuto(false);
      setAssistantOpen(open);
      const savedAt = Date.now();
      writeCachedPref(storage, assistantOpenStorageKey(user.id), company.id, { value: open, savedAt });
      latest.current.onAssistantOpenChange?.(open, savedAt);
    },
    [storage, user.id, company.id],
  );
  // Ctrl+/ (⌘/ on a Mac) shows the assistant with the caret in its input, or hides it and returns the caret to the page.
  const openRef = useRef(assistantOpen);
  useEffect(() => {
    openRef.current = assistantOpen;
  }, [assistantOpen]);
  const [focusInput, setFocusInput] = useState(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key !== "/") return;
      // A dialog (the palette, a confirmation) owns the keyboard while it is open.
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], dialog[open]')) return;
      event.preventDefault();
      if (openRef.current) {
        document.getElementById("erp-main")?.focus({ preventScroll: true });
        chooseAssistant(false);
      } else {
        chooseAssistant(true);
        setFocusInput((n) => n + 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [chooseAssistant]);
  const [asked, setAsked] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const ask = useCallback((text: string) => {
    if (!text) return;
    setAssistantAuto(false);
    setAssistantOpen(true);
    setAsked((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }));
  }, []);
  const { gridHref } = props.assistantOptions ?? {};
  const openGrid = (entity: string, state: GridStateInput) => {
    const href = gridHref?.(entity);
    if (href) navigate(gridQueryHref(href, state));
  };

  const paletteItems = useMemo<CommandItem[]>(
    () => [
      { id: "go:home", label: t("nav.shell.palette.go", { label: t("nav.shell.home") }), kind: "go", href: "/" },
      ...nav.map((item): CommandItem => {
        const keywords = t.has(`nav.keywords.${item.id}`) ? t(`nav.keywords.${item.id}`).split(/\s+/) : undefined;
        return { id: `go:${item.id}`, label: t("nav.shell.palette.go", { label: t(item.label) }), kind: "go", href: item.href, ...(keywords ? { keywords } : {}) };
      }),
      ...commands,
    ],
    [nav, commands, t],
  );

  const activeTab = useStore(store, (state) => state.tabs.find((tab) => tab.id === state.activeId));

  const timeZone = props.assistantOptions?.timeZone ?? company.timeZone;

  return (
    <CellFormatProvider timeZone={timeZone}>
      <NavigateProvider navigate={navigate}>
      <TabsProvider store={store}>
        {/* Exports outlive the grid that started them: a tab change no longer aborts a background job. */}
        <ExportJobsProvider>
        <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-page text-text">
          <a
            href="#erp-main"
            className="sr-only rounded-md bg-surface px-3 py-2 text-[13px] font-semibold text-link focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:shadow-[0_10px_30px_var(--shadow)]"
          >
            {t("nav.shell.skip_to_content")}
          </a>
          <TopBar
            company={company}
            companies={companies}
            user={user}
            modules={visibleModules}
            itemsByModule={itemsByModule}
            activeModuleId={activeModuleId}
            onSelectModule={selectModule}
            activeHref={currentHref}
            onNavigate={(target) => navigate(target.href)}
            theme={theme}
            onThemeChange={(mode) => changeTheme(mode)}
            onOpenPalette={() => setPaletteOpen(true)}
            assistantOpen={assistantOpen}
            onToggleAssistant={() => chooseAssistant(!assistantOpen)}
            onSwitchCompany={props.onSwitchCompany}
            signOutAction={props.signOutAction}
          />
          <TabsBar onNew={() => setPaletteOpen(true)} />
          <div className="flex min-h-0 flex-1">
            <main id="erp-main" tabIndex={-1} className="erp-main" {...(denseRoute(currentHref) ? { "data-density": "tight" } : {})}>
              <AskAssistantProvider ask={ask}>{props.children}</AskAssistantProvider>
            </main>
            <AssistantDrawer
              open={assistantOpen}
              auto={assistantAuto}
              focusInput={focusInput}
              context={activeTab && activeTab.kind !== "home" ? activeTab.title : t("nav.shell.home")}
              screen={screenOf(currentHref)}
              {...(asked ? { ask: asked } : {})}
              onNavigate={navigate}
              onOpenGrid={openGrid}
              canOpenGrid={(entity) => gridHref?.(entity) !== undefined}
              {...(props.assistantOptions?.columnsOf ? { columnsOf: props.assistantOptions.columnsOf } : {})}
            />
          </div>
          <CommandPalette
            items={paletteItems}
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            onAsk={ask}
            onSelect={(item) => navigate(item.href)}
          />
          <Toaster position="bottom-center" />
        </div>
        </ExportJobsProvider>
      </TabsProvider>
      </NavigateProvider>
    </CellFormatProvider>
  );
}
