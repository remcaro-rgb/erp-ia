"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams, useServerInsertedHTML } from "next/navigation";
import { AppShell, themeScript, UnsavedProvider, type TabsSnapshot, type ThemeMode, type UnsavedState } from "@erp/ui";
import { setActiveCompany } from "@/lib/auth/active-company";
import { signOut } from "@/lib/auth/actions";
import { findRecordsById } from "@/lib/records/find-by-id";
import { changeOwnPasswordAction, disableOwnMfaAction } from "@/lib/auth/mfa-actions";
import { clearCloneHandoff } from "@/lib/records/clone-handoff";
import { gridHref } from "@/lib/grid/hrefs";
import { saveShellPrefAction } from "@/lib/prefs/actions";
import { installCapture, noteRoute } from "@/lib/support/capture";
import type { ShellData } from "@/lib/shell/load";
import { guardedNavigate, useLeaveGuard } from "./leave-guard";
import { useStepUpAction } from "./use-step-up";

/**
 * The record forms with unsaved changes (UX-OD-4), reported by the forms while they are mounted. While any exists the leave
 * guard holds navigation, the tab close, the company switch and the sign-out behind "Guardar · Descartar · Cancelar", and the
 * browser asks on refresh or close. `dialog` is the question to render while one waits.
 */
function useUnsavedBridge() {
  const forms = useRef(new Map<string, UnsavedState>());
  const [count, setCount] = useState(0);
  const report = useCallback((id: string, state: UnsavedState | null) => {
    if (state) forms.current.set(id, state);
    else forms.current.delete(id);
    setCount(forms.current.size);
  }, []);
  const save = useCallback(async () => {
    for (const form of [...forms.current.values()]) if (!(await form.save())) return false;
    return true;
  }, []);
  const dialog = useLeaveGuard(count, { save });
  const value = useMemo(() => ({ report, hasUnsaved: count > 0 }), [report, count]);
  return { value, dialog };
}

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
  // "Abrir en una pestaña nueva": the record alone, using the whole browser tab (no top bar, side menu or tabs).
  const bare = useSearchParams().get("view") === "full" && pathname.startsWith("/r/");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<PendingSave | null>(null);
  // "Verificación en dos pasos" of the user menu: kernel.user.mfa.disable through the step-up flow every sensitive run uses.
  const unsaved = useUnsavedBridge();
  const { run: runWithStepUp, prompt: mfaStepUpPrompt, cancel: cancelMfaStepUp } = useStepUpAction();

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
    <UnsavedProvider value={unsaved.value}>
    <AppShell
      findRecords={findRecordsById}
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
      bare={bare}
      // A screen with staged changes (the admin matrices) may ask before the shell leaves it.
      navigate={(href) => guardedNavigate(() => router.push(href))}
      onThemeChange={(mode: ThemeMode, savedAt: number) => void saveShellPrefAction({ key: "theme", value: mode, savedAt })}
      onAssistantOpenChange={(open, savedAt) => void saveShellPrefAction({ key: "assistant.open", value: open, savedAt })}
      onTabsChange={saveTabs}
      confirmLeave={guardedNavigate}
      onSwitchCompany={(companyId) =>
        // Unsaved changes belong to the company being left: the question comes before the claims change, never after.
        new Promise<void>((resolve) =>
          guardedNavigate(() => {
            void (async () => {
              // The pending tabs belong to the company being left: store them there before the claims change.
              await flush();
              // A copy on its way to a create form ("Duplicar") belongs to the company being left.
              clearCloneHandoff();
              await setActiveCompany(companyId);
              router.refresh();
            })().finally(resolve);
          }),
        )
      }
      mfa={data.mfa}
      {...(data.notifications ? { notifications: data.notifications } : {})}
      mfaStepUpPrompt={mfaStepUpPrompt}
      onCancelMfaStepUp={cancelMfaStepUp}
      onDisableMfa={async () => {
        const result = await runWithStepUp((stepUpToken) => disableOwnMfaAction(stepUpToken));
        if (result.ok) {
          // Auth ended every session of the user with the factor: the action cleared this one's cookies. A full load of
          // the sign-in page (with the notice) drops whatever this tab still holds.
          if (result.next) {
            clearCloneHandoff();
            window.location.assign(result.next);
          } else router.refresh();
        }
        return result;
      }}
      onChangePassword={(currentPassword, newPassword) => changeOwnPasswordAction(currentPassword, newPassword)}
      signOutAction={() =>
        new Promise<void>((resolve) =>
          guardedNavigate(() => {
            // Nothing of this session's records stays in the tab's memory.
            clearCloneHandoff();
            void signOut().finally(resolve);
          }),
        )
      }
    >
      {children}
    </AppShell>
    {unsaved.dialog && (
      <div className="fixed inset-x-3 bottom-6 z-[70] mx-auto flex max-w-[640px] rounded-lg border border-line bg-surface p-3 text-text shadow-[0_10px_30px_var(--shadow)]">{unsaved.dialog}</div>
    )}
    </UnsavedProvider>
  );
}
