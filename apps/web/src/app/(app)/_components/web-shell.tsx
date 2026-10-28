"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter, useServerInsertedHTML } from "next/navigation";
import { AppShell, themeScript, type TabsSnapshot, type ThemeMode } from "@erp/ui";
import { setActiveCompany } from "@/lib/auth/active-company";
import { signOut } from "@/lib/auth/actions";
import { saveShellPref } from "@/lib/prefs/actions";
import type { ShellData } from "@/lib/shell/load";

/** Tabs change in bursts (open, open, close): save the last state once things settle. */
const SAVE_TABS_AFTER_MS = 800;

/** The application shell wired to Next: the router navigates, server actions save the theme and the tabs. */
export function WebShell({ data, children }: { data: ShellData; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The saved theme on <html> before the first paint of a server render; a client render applies it in the shell.
  useServerInsertedHTML(() => <script dangerouslySetInnerHTML={{ __html: themeScript(data.theme) }} />);

  const saveTabs = useCallback((snapshot: TabsSnapshot) => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => void saveShellPref({ key: "tabs", value: snapshot }), SAVE_TABS_AFTER_MS);
  }, []);
  useEffect(() => () => void (pending.current && clearTimeout(pending.current)), []);

  return (
    <AppShell
      company={data.company}
      companies={data.companies}
      user={data.user}
      modules={data.modules}
      nav={data.nav}
      commands={data.commands}
      theme={data.theme}
      initialTabs={data.tabs}
      currentHref={pathname}
      navigate={(href) => router.push(href)}
      onThemeChange={(mode: ThemeMode) => void saveShellPref({ key: "theme", value: mode })}
      onTabsChange={saveTabs}
      onSwitchCompany={async (companyId) => {
        await setActiveCompany(companyId);
        router.refresh();
      }}
      signOutAction={signOut}
    >
      {children}
    </AppShell>
  );
}
