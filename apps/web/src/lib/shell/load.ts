import "server-only";
import { getTranslations } from "next-intl/server";
import { callerProfile, entitled, ProcessError, runnableProcesses, runProcess, type Caller } from "@erp/kernel";
import { isThemeMode, type CommandItem, type NavItem, type ShellCompany, type ShellModule, type ShellUser, type ThemeMode } from "@erp/ui";
import { processDeps } from "@/lib/server/runtime";
import { buildShellNav, shellAccessKeys } from "./nav";

// Everything the (app) layout hands the application shell, read as the caller: who they are, their companies,
// the modules and menu items they may open, the create commands for ⌘K and their saved theme and tabs.

export interface ShellData {
  company: ShellCompany;
  companies: ShellCompany[];
  user: ShellUser;
  modules: ShellModule[];
  nav: NavItem[];
  commands: CommandItem[];
  theme: ThemeMode;
  /** The saved tabs as stored (the shell repairs them), or null when the user has none yet. */
  tabs: unknown;
}

/** A saved preference of the caller, or null; a preference never breaks the page. */
async function pref(caller: Caller, key: string): Promise<unknown> {
  try {
    const out = await runProcess(processDeps(), caller, "kernel.user_prefs.get", { key });
    return (out as { value: unknown }).value;
  } catch (error) {
    if (error instanceof ProcessError) return null;
    throw error;
  }
}

export async function loadShell(caller: Caller): Promise<ShellData> {
  const deps = processDeps();
  const { claims } = caller;
  const keys = shellAccessKeys(deps.registry);
  const [profile, entitledKeys, runnable, theme, tabs, t] = await Promise.all([
    callerProfile(deps.sql, claims),
    Promise.all(keys.entitlements.map(async (key) => ((await entitled(deps.sql, claims.active_company_id, key)) ? key : null))),
    runnableProcesses(deps.sql, deps.registry, claims, keys.processes),
    pref(caller, "theme"),
    pref(caller, "tabs"),
    getTranslations(),
  ]);
  const shell = buildShellNav(deps.registry, { entitled: new Set(entitledKeys.filter((k): k is string => k !== null)), runnable });

  const commands: CommandItem[] = shell.creates
    .filter((create) => t.has(create.labelKey))
    .map((create) => ({ id: `create:${create.processId}`, label: t("nav.shell.palette.create", { entity: t(create.labelKey) }), kind: "create", href: create.href }));

  const company = profile.companies.find((c) => c.id === claims.active_company_id) ?? { id: claims.active_company_id, name: "", taxId: null };
  return {
    company,
    companies: profile.companies,
    user: { id: profile.user.id, name: profile.user.name, email: profile.user.email, roles: profile.roles },
    modules: shell.modules,
    nav: shell.nav,
    commands,
    theme: isThemeMode(theme) ? theme : "auto",
    tabs,
  };
}
