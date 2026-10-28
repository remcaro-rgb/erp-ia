"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useStore } from "zustand";
import { Toaster } from "@erp/ui/components/ui/sonner";
import { AssistantDrawer } from "./AssistantDrawer";
import { CommandPalette } from "./CommandPalette";
import { isActiveHref } from "./ModuleBar";
import { TabsBar } from "./TabsBar";
import { newerSaved, readCachedPref, themeStorageKey, writeCachedPref } from "./prefs-cache";
import { createTabsStore, loadCachedTabs, TabsProvider, type TabsStore } from "./tabs-store";
import { applyTheme, isThemeMode } from "./theme";
import { TopBar } from "./TopBar";
import { moduleOf, type CommandItem, type NavItem, type Saved, type ShellCompany, type ShellModule, type ShellUser, type TabKind, type TabsSnapshot, type ThemeMode } from "./types";

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
  /** The assistant (Task 17); a placeholder conversation until then. */
  assistant?: ReactNode;
  children: ReactNode;
  /** Path of the page being shown (no query). */
  currentHref: string;
  /** Client-side navigation (the app's router). */
  navigate: (href: string) => void;
  /** The user's saved theme in this company (`kernel.user_prefs`, key `theme`), or null. */
  theme?: Saved<ThemeMode> | null;
  /** A theme change with its time, to save it (the shell already caches it in localStorage). */
  onThemeChange?: (mode: ThemeMode, savedAt: number) => void;
  /** The user's saved tabs in this company (`kernel.user_prefs`, key `tabs`), or null. */
  initialTabs?: Saved<unknown> | null;
  /** Every change of the tabs with its time, to save them (the shell already caches them in localStorage). */
  onTabsChange?: (snapshot: TabsSnapshot, savedAt: number) => void;
  onSwitchCompany?: (companyId: string) => void;
  signOutAction?: () => void | Promise<void>;
  /** The preference cache; the browser's localStorage by default. */
  storage?: Storage | null;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
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
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [questions, setQuestions] = useState<string[]>([]);
  const ask = (text: string) => {
    if (!text) return;
    setAssistantOpen(true);
    setQuestions((q) => [...q, text]);
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

  return (
    <TabsProvider store={store}>
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-page text-text">
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
          onToggleAssistant={() => setAssistantOpen((open) => !open)}
          onSwitchCompany={props.onSwitchCompany}
          signOutAction={props.signOutAction}
        />
        <TabsBar onNew={() => setPaletteOpen(true)} />
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto px-6 py-5">{props.children}</main>
          <AssistantDrawer
            open={assistantOpen}
            context={activeTab && activeTab.kind !== "home" ? activeTab.title : t("nav.shell.home")}
            questions={questions}
            onAsk={ask}
          >
            {props.assistant}
          </AssistantDrawer>
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
    </TabsProvider>
  );
}
