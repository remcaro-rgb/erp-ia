"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter, useServerInsertedHTML } from "next/navigation";
import { AppShell, themeScript, type TabsSnapshot, type ThemeMode } from "@erp/ui";
import { setActiveCompany } from "@/lib/auth/active-company";
import { signOut } from "@/lib/auth/actions";
import { clearCloneHandoff } from "@/lib/records/clone-handoff";
import { gridHref } from "@/lib/grid/hrefs";
import { saveShellPrefAction } from "@/lib/prefs/actions";
import { installCapture, noteRoute } from "@/lib/support/capture";
import type { ShellData } from "@/lib/shell/load";
import { guardedNavigate } from "./leave-guard";

/** Tabs change in bursts (open, open, close): save the last state once things settle. */
const SAVE_TABS_AFTER_MS = 800;

type PendingSave = { key: "tabs"; value: TabsSnapshot; savedAt: number };

/**
 * The application shell wired to Next: the router navigates, a server action saves the theme and (debounced)
 * the tabs. A tabs save still pending when the page goes away (`pagehide`) is sent with `navigator.sendBeacon`
 * to POST /api/prefs; one pending at a company switch is saved before the switch.
 */
export function WebShell({ data, children }: { data: ShellData; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<PendingSave | null>(null);

  // The saved theme on <html> before the first paint of a server render; a client render applies it in the shell.
  useServerInsertedHTML(() => <script dangerouslySetInnerHTML={{ __html: themeScript(data.theme?.value ?? "auto") }} />);

  // The context a support ticket carries (route, selection, console errors) is remembered from the first screen on.
  useEffect(() => installCapture(), []);
  useEffect(() => noteRoute(pathname), [pathname]);

  /** Sends the pending save now through the action; resolves when it is stored. */
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const save = pending.current;
    pending.current = null;
    if (save) await saveShellPrefAction(save);
  }, []);

  const saveTabs = useCallback(
    (snapshot: TabsSnapshot, savedAt: number) => {
      pending.current = { key: "tabs", value: snapshot, savedAt };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_TABS_AFTER_MS);
    },
    [flush],
  );

  useEffect(() => {
    const onPageHide = () => {
      const save = pending.current;
      if (!save) return;
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      navigator.sendBeacon("/api/prefs", new Blob([JSON.stringify(save)], { type: "application/json" }));
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      onPageHide();
    };
  }, []);

  return (
    <AppShell
      company={data.company}
      companies={data.companies}
      user={data.user}
      modules={data.modules}
      nav={data.nav}
      commands={data.commands}
      assistantOptions={{ gridHref, columnsOf: (entity) => data.assistantColumns[entity], ...(data.company.timeZone ? { timeZone: data.company.timeZone } : {}) }}
      theme={data.theme}
      assistantOpen={data.assistantOpen}
      initialTabs={data.tabs}
      currentHref={pathname}
      // A screen with staged changes (the admin matrices) may ask before the shell leaves it.
      navigate={(href) => guardedNavigate(() => router.push(href))}
      onThemeChange={(mode: ThemeMode, savedAt: number) => void saveShellPrefAction({ key: "theme", value: mode, savedAt })}
      onAssistantOpenChange={(open, savedAt) => void saveShellPrefAction({ key: "assistant.open", value: open, savedAt })}
      onTabsChange={saveTabs}
      onSwitchCompany={async (companyId) => {
        // The pending tabs belong to the company being left: store them there before the claims change.
        await flush();
        // A copy on its way to a create form ("Duplicar") belongs to the company being left.
        clearCloneHandoff();
        await setActiveCompany(companyId);
        router.refresh();
      }}
      signOutAction={async () => {
        // Nothing of this session's records stays in the tab's memory.
        clearCloneHandoff();
        await signOut();
      }}
    >
      {children}
    </AppShell>
  );
}
