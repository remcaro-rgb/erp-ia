"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useStore } from "zustand";
import { Toaster } from "@erp/ui/components/ui/sonner";
import { AssistantDrawer, screenOf, type ResultColumn } from "../assistant";
import { CellFormatProvider } from "../grid/cell-format";
import { ExportJobsProvider } from "../grid/export-jobs";
import { FormPrefsProvider } from "../forms/form-context";
import { gridQueryHref } from "../grid/query-link";
import type { GridStateInput } from "../grid/types";
import { CommandPalette } from "./CommandPalette";
import { MfaDialog, type MfaDisableResult, type MfaState } from "./MfaDialog";
import { isActiveHref, ModuleBar } from "./ModuleBar";
import { SideMenu } from "./SideMenu";
import { TabsBar } from "./TabsBar";
import { AskAssistantProvider } from "./ask-assistant";
import { NavigateProvider } from "./navigate";
import { assistantOpenStorageKey, browserStorage, dianHintsStorageKey, sideMenuStorageKey, newerSaved, readCachedPref, themeStorageKey, writeCachedPref } from "./prefs-cache";
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
  /** ⌘K by ID (D16): the records whose ID is `id`. */
  findRecords?: (id: number) => Promise<CommandItem[]>;
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
  /** A page opened alone in its own browser tab: only the page, without the top bar, side menu, tabs or assistant; nothing of it is saved to the tabs. */
  bare?: boolean;
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
  /** Whether the user turned on "Ver códigos DIAN" in the record forms (`kernel.user_prefs`, key `forms.dian_hints`), or null: off. */
  dianHints?: Saved<boolean> | null;
  /** The user switched the DIAN hints, with the time, to save it (the shell already caches it in localStorage). */
  onDianHintsChange?: (on: boolean, savedAt: number) => void;
  /** The user's saved tabs in this company (`kernel.user_prefs`, key `tabs`), or null. */
  initialTabs?: Saved<unknown> | null;
  /** Every change of the tabs with its time, to save them (the shell already caches them in localStorage). */
  onTabsChange?: (snapshot: TabsSnapshot, savedAt: number) => void;
  /** Asks before the shown screen's tab is closed while it has unsaved changes; runs `go` when it may (Guardar · Descartar · Cancelar). */
  confirmLeave?: (go: () => void) => void;
  onSwitchCompany?: (companyId: string) => void;
  signOutAction?: () => void | Promise<void>;
  /** The caller's second step (design §22.19); with `onDisableMfa`, the user menu offers "Verificación en dos pasos". */
  mfa?: MfaState;
  /** Runs kernel.user.mfa.disable through the app's step-up flow; on success the app ends the session. */
  onDisableMfa?: () => Promise<MfaDisableResult>;
  /** The app's step-up prompt while that run waits for the code (rendered inside the dialog). */
  mfaStepUpPrompt?: ReactNode;
  /** Cancels that waiting step-up (the dialog was closed). */
  onCancelMfaStepUp?: () => void;
  /** The preference cache; the browser's localStorage by default. */
  storage?: Storage | null;
}

/** Below this viewport width the assistant drawer starts closed (OD-10: it would leave the page under ~920 px at 1366). */
const ASSISTANT_MIN_WIDTH = 1280;
/** Under this width the assistant is a full-screen sheet (UX-OD-2). */
const SHEET_BELOW = 768;

/** Grid and admin routes use the tighter page padding (OD-1); the home and the record page keep v5's. */
/** From this viewport width the side menu starts expanded when the viewer never chose (shell v7, design §22.24). */
const SIDE_MENU_OPEN_FROM = 1440;

const denseRoute = (href: string): boolean => href !== "/" && !href.startsWith("/r/");

function readBooleanPref(storage: Storage | null, key: string, companyId: string): Saved<boolean> | null {
  const cached = readCachedPref(storage, key, companyId);
  return cached && typeof cached.value === "boolean" ? { value: cached.value, savedAt: cached.savedAt } : null;
}

/** The palette's options keyed by id: an id never appears twice (React keys, one active option). */
const uniqueById = (items: CommandItem[]): CommandItem[] => [...new Map(items.map((item) => [item.id, item])).values()];

/** The entity id of a record page `/r/<entity>/<id>`, else undefined. */
const recordEntityOf = (href: string): string | undefined => /^\/r\/([a-z_]+\.[a-z_]+)\//.exec(href)?.[1];

/** Pages with no menu item of their own (the nav label of a covering item, an entity's noun, or the page's name) never show as a raw path. */
const ROUTE_TITLES: Record<string, string> = {
  "/accounting/setup": "nav.shell.routes.accounting_setup",
  "/admin/roles": "nav.shell.routes.admin_roles",
  "/admin/users": "nav.shell.routes.admin_users",
  "/admin/fields": "nav.shell.routes.admin_fields",
  "/admin/extra": "nav.shell.routes.admin_extra",
  "/admin/required-files": "nav.shell.routes.admin_required_files",
  "/admin/sensitive": "nav.shell.routes.admin_sensitive",
  "/admin/verifiers": "nav.shell.routes.admin_verifiers",
  "/admin/modules": "nav.shell.routes.admin_modules",
  "/admin/companies": "nav.shell.routes.admin_companies",
};

/** The name of a module's report page (`/accounting/reports/trial_balance`, query allowed), not the menu item covering all of them. */
function reportTitleOf(href: string, t: ReturnType<typeof useTranslations>): string | undefined {
  const report = /^\/([a-z_]+)\/reports\/([a-z_]+)(?:\?|$)/.exec(href);
  return report && t.has(`report.${report[1]}.${report[2]}`) ? t(`report.${report[1]}.${report[2]}`) : undefined;
}

function routeTitle(href: string, items: readonly NavItem[], t: ReturnType<typeof useTranslations>): string {
  const entity = recordEntityOf(href);
  if (entity) return t.has(`entity.${entity}`) ? t(`entity.${entity}`) : t("nav.shell.record");
  const report = reportTitleOf(href, t);
  if (report) return report;
  const named = ROUTE_TITLES[href];
  if (named) return t(named);
  const covering = items.filter((i) => i.href !== "#" && isActiveHref(i.href, href)).sort((a, b) => b.href.length - a.href.length)[0];
  if (covering) return t(covering.label);
  // A sub-page of a named page (`/admin/users/<id>`) takes its parent's name; anything else is the generic "Página".
  const parent = Object.keys(ROUTE_TITLES).find((route) => href.startsWith(`${route}/`));
  return parent ? t(ROUTE_TITLES[parent]!) : t("nav.shell.page");
}

/**
 * The application shell (design §19a, shell v7 §22.24): navy top bar, the side menu of module names, the items bar of the active module's sections, the tinted tabs row,
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
      storage: props.bare ? null : storage,
      initial: props.bare ? undefined : props.initialTabs?.value,
      onChange: (snapshot, savedAt) => {
        if (!latest.current.bare) latest.current.onTabsChange?.(snapshot, savedAt);
      },
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
    if (props.bare) return;
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
        if (state.activeId === previous.activeId || latest.current.bare) return;
        const tab = state.tabs.find((x) => x.id === state.activeId);
        if (tab && tab.href !== current.current) latest.current.navigate(tab.href);
      }),
    [store],
  );

  // A tab the user activated: if its page redirects, the page it lands on replaces the tab instead of opening a second one.
  const activated = useRef<{ id: string; href: string } | null>(null);
  /** The page effect below opens its own tab: that activation is not the user's. */
  const opening = useRef(false);
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (state.activeId === previous.activeId || opening.current) return;
        const tab = state.tabs.find((x) => x.id === state.activeId);
        activated.current = tab && !tab.pinned ? { id: tab.id, href: tab.href } : null;
      }),
    [store],
  );

  // The page decides the tab: a menu screen, a record (named after its entity), Inicio, or any other path.
  useEffect(() => {
    if (props.bare) return;
    const flat = nav.flatMap((i) => i.children ?? [i]);
    const item = flat.find((i) => i.href === currentHref);
    const kind: TabKind = currentHref === "/" ? "home" : currentHref.startsWith("/r/") ? "record" : "grid";
    const title = item ? t(item.label) : routeTitle(currentHref, flat, t);
    const landed = activated.current;
    activated.current = null;
    // A tab the user opened for this page with parameters ("…/account_detail?p=…", the drill-down of a report row) already is
    // this page: the shell sees only the path, so it must not open a second, bare tab for it.
    const shown = store.getState().tabs.find((x) => x.id === store.getState().activeId);
    if (shown && shown.href !== currentHref && shown.href.split("?")[0] === currentHref) return;
    if (landed && landed.href.split("?")[0] !== currentHref.split("?")[0] && !store.getState().tabs.some((x) => x.href === currentHref)) store.getState().close(landed.id);
    opening.current = true;
    store.getState().open({ title, href: currentHref, kind });
    opening.current = false;
  }, [currentHref, nav, store, t]);

  // Tabs saved before reports were named by the report still read "Informes": they take the report's name once, on load.
  useEffect(() => {
    const flat = nav.flatMap((i) => i.children ?? [i]);
    for (const tab of store.getState().tabs) {
      const name = reportTitleOf(tab.href, t);
      const covering = flat.find((i) => i.href !== "#" && isActiveHref(i.href, tab.href.split("?")[0]!));
      if (name && covering && tab.title === t(covering.label)) store.getState().rename(tab.href, name);
    }
  }, [nav, store, t]);

  // The module bar follows the page being shown, except right after the user picks a module in the Módulos menu: that
  // choice wins until the page changes (a pick from a page of another module would otherwise never show).
  const [selectedModule, setSelectedModule] = useState<string | undefined>(undefined);
  const hrefModule = nav.flatMap((i) => i.children ?? [i]).find((i) => isActiveHref(i.href, currentHref));
  // A record page (/r/<module>.<entity>/<id>) belongs to its entity's module.
  const recordModule = visibleModules.find((m) => m.id === recordEntityOf(currentHref)?.split(".")[0])?.id;
  const activeModuleId = selectedModule ?? (hrefModule ? moduleOf(hrefModule) : undefined) ?? recordModule ?? visibleModules[0]?.id;
  useEffect(() => setSelectedModule(undefined), [currentHref]);

  const activeModule = visibleModules.find((m) => m.id === activeModuleId);

  /** Picking a module brings its open tab to the front, or opens its first option when none of its pages is open. */
  const selectModule = (moduleId: string) => {
    setSelectedModule(moduleId);
    const items = (itemsByModule[moduleId] ?? []).filter((i) => i.menu !== false).flatMap((i) => i.children ?? [i]);
    const openTab = store.getState().tabs.find((tab) => items.some((i) => isActiveHref(i.href, tab.href)));
    if (openTab) store.getState().activate(openTab.id);
    else if (items[0]) navigate(items[0].href);
  };

  // Shell v7 side menu (design §22.24): the viewer's saved choice of the 60 px rail, else collapsed below 1440 px. The server render and
  // hydration use the CSS-first `auto` state (null), so the first paint is right; the effect then resolves it before the first paint.
  const [sideCollapsed, setSideCollapsed] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const saved = readBooleanPref(storage, sideMenuStorageKey(user.id), company.id);
    setSideCollapsed(saved ? saved.value : window.innerWidth < SIDE_MENU_OPEN_FROM);
    // Once per mounted shell, like the drawer.
  }, []);
  const toggleSide = () => {
    const next = !(sideCollapsed ?? window.innerWidth < SIDE_MENU_OPEN_FROM);
    setSideCollapsed(next);
    writeCachedPref(storage, sideMenuStorageKey(user.id), company.id, { value: next, savedAt: Date.now() });
  };

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mfaOpen, setMfaOpen] = useState(false);
  const mfaWired = props.mfa !== undefined && props.onDisableMfa !== undefined;
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
    // Under 768 px the assistant is a full-screen sheet: a choice saved on a wider screen never opens it over a phone.
    setAssistantOpen(saved && window.innerWidth >= SHEET_BELOW ? saved.value : window.innerWidth >= ASSISTANT_MIN_WIDTH);
    // Once per mounted shell: the first render's saved copies and viewport decide.
  }, []);
  /** A toggle by the user: remembered for the next visit. (Opening it to answer ⌘K is not a choice and is not saved.) */
  const chooseAssistant = useCallback(
    (open: boolean) => {
      setAssistantAuto(false);
      setAssistantOpen(open);
      // A choice made on a phone does not overwrite the one of the wider screens.
      if (window.innerWidth < SHEET_BELOW) return;
      const savedAt = Date.now();
      writeCachedPref(storage, assistantOpenStorageKey(user.id), company.id, { value: open, savedAt });
      latest.current.onAssistantOpenChange?.(open, savedAt);
    },
    [storage, user.id, company.id],
  );
  // "Ver códigos DIAN" in the record forms: the server's saved choice renders first (no flash), a newer one of this
  // browser's cache replaces it before the first paint. Off when never chosen.
  const [dianHints, setDianHintsState] = useState(props.dianHints?.value ?? false);
  useLayoutEffect(() => {
    const saved = newerSaved(props.dianHints ?? null, readBooleanPref(storage, dianHintsStorageKey(user.id), company.id));
    if (saved) setDianHintsState(saved.value);
    // Once per mounted shell, like the drawer.
  }, []);
  const formPrefs = useMemo(
    () => ({
      dianHints,
      setDianHints: (on: boolean) => {
        setDianHintsState(on);
        const savedAt = Date.now();
        writeCachedPref(storage, dianHintsStorageKey(user.id), company.id, { value: on, savedAt });
        latest.current.onDianHintsChange?.(on, savedAt);
      },
    }),
    [dianHints, storage, user.id, company.id],
  );
  const [focusInput, setFocusInput] = useState(0);
  /** Opening puts the caret in the composer; closing returns the focus to the toggle (UX-OD-2). */
  const openAssistant = useCallback(() => {
    chooseAssistant(true);
    setFocusInput((n) => n + 1);
  }, [chooseAssistant]);
  const closeAssistant = useCallback(() => {
    chooseAssistant(false);
    // After the sheet has released the page behind it (inert) on the next frame.
    window.setTimeout(() => document.getElementById("erp-assistant-toggle")?.focus({ preventScroll: true }), 0);
  }, [chooseAssistant]);
  // Ctrl+/ (⌘/ on a Mac) shows the assistant with the caret in its input, or hides it and returns the caret to the page.
  const openRef = useRef(assistantOpen);
  useEffect(() => {
    openRef.current = assistantOpen;
  }, [assistantOpen]);
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
    () => uniqueById([
      { id: "go:home", label: t("nav.shell.palette.go", { label: t("nav.shell.home") }), kind: "go", href: "/" },
      // ⌘K lists the screens: the children of a group, never the group itself.
      ...nav.flatMap((item) => item.children ?? [item]).map((item): CommandItem => {
        const keywords = t.has(`nav.keywords.${item.id}`) ? t(`nav.keywords.${item.id}`).split(/\s+/) : undefined;
        return { id: `go:${item.id}`, label: t("nav.shell.palette.go", { label: t(item.label) }), kind: "go", href: item.href, ...(keywords ? { keywords } : {}) };
      }),
      ...commands,
    ]),
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
        {props.bare ? (
          <main id="erp-main" tabIndex={-1} className="erp-main h-dvh overflow-auto">
            <AskAssistantProvider ask={ask}>
              <FormPrefsProvider value={formPrefs}>{props.children}</FormPrefsProvider>
            </AskAssistantProvider>
          </main>
        ) : (
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
            activeModuleId={activeModuleId}
            onSelectModule={selectModule}
            theme={theme}
            onThemeChange={(mode) => changeTheme(mode)}
            onOpenPalette={() => setPaletteOpen(true)}
            assistantOpen={assistantOpen}
            onToggleAssistant={() => (assistantOpen ? closeAssistant() : openAssistant())}
            onSwitchCompany={props.onSwitchCompany}
            signOutAction={props.signOutAction}
            {...(mfaWired ? { mfaEnrolled: props.mfa!.enrolled, onOpenMfa: () => setMfaOpen(true) } : {})}
          />
          <div className="flex min-h-0 flex-1">
            <SideMenu modules={visibleModules} activeModuleId={activeModuleId} onSelectModule={selectModule} collapsed={sideCollapsed} onToggle={toggleSide} />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {activeModule && (
                <div className="erp-itemsbar">
                  <span className="erp-itemsbar-mod">{t(activeModule.label)}</span>
                  <ModuleBar
                    items={(itemsByModule[activeModule.id] ?? []).filter((item) => item.menu !== false)}
                    showHome={activeModule.id === visibleModules[0]?.id}
                    activeHref={currentHref}
                    onNavigate={(target) => navigate(target.href)}
                  />
                </div>
              )}
              <TabsBar onNew={() => setPaletteOpen(true)} {...(props.confirmLeave ? { confirmLeave: props.confirmLeave } : {})} />
              <div className="flex min-h-0 flex-1">
                <main id="erp-main" tabIndex={-1} className="erp-main" {...(denseRoute(currentHref) ? { "data-density": "tight" } : {})}>
                  <AskAssistantProvider ask={ask}>
                    <FormPrefsProvider value={formPrefs}>{props.children}</FormPrefsProvider>
                  </AskAssistantProvider>
                </main>
                <AssistantDrawer
                  open={assistantOpen}
                  auto={assistantAuto}
                  focusInput={focusInput}
                  onClose={closeAssistant}
                  context={activeTab && activeTab.kind !== "home" ? activeTab.title : t("nav.shell.home")}
                  screen={screenOf(currentHref)}
                  {...(asked ? { ask: asked } : {})}
                  onNavigate={navigate}
                  onOpenGrid={openGrid}
                  canOpenGrid={(entity) => gridHref?.(entity) !== undefined}
                  {...(props.assistantOptions?.columnsOf ? { columnsOf: props.assistantOptions.columnsOf } : {})}
                />
              </div>
            </div>
          </div>
          <CommandPalette
            items={paletteItems}
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            onAsk={ask}
            onSelect={(item) => navigate(item.href)}
            {...(props.findRecords ? { findRecords: props.findRecords } : {})}
          />
          {mfaWired && (
            <MfaDialog
              open={mfaOpen}
              onOpenChange={setMfaOpen}
              {...props.mfa!}
              onDisable={() => props.onDisableMfa!()}
              stepUpPrompt={props.mfaStepUpPrompt}
              {...(props.onCancelMfaStepUp ? { onCancelStepUp: props.onCancelMfaStepUp } : {})}
            />
          )}
          <Toaster position="bottom-center" />
        </div>
        )}
        </ExportJobsProvider>
      </TabsProvider>
      </NavigateProvider>
    </CellFormatProvider>
  );
}
