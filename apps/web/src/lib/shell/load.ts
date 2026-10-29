import "server-only";
import { cache } from "react";
import { getTranslations } from "next-intl/server";
import { callerProfile, entitled, readUserPrefs, runnableProcesses, type Caller } from "@erp/kernel";
import { isThemeMode, type CommandItem, type ResultColumn, type NavItem, type Saved, type ShellCompany, type ShellModule, type ShellUser, type ThemeMode } from "@erp/ui";
import { requireCaller, Unauthenticated } from "@/lib/auth/claims";
import { savedFrom } from "@/lib/prefs/validate";
import { processDeps, registrySynced } from "@/lib/server/runtime";
import { loadAssistantColumns } from "./assistant-columns";
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
  /** The saved theme in the active company, or null. */
  theme: Saved<ThemeMode> | null;
  /** Labels and types of the fields of each entity with a grid, for the assistant's result tables. */
  assistantColumns: Record<string, ResultColumn[]>;
  /** Whether the user last left the assistant drawer open or closed in the active company, or null (the viewport decides). */
  assistantOpen: Saved<boolean> | null;
  /** The saved tabs as stored (the shell repairs them), or null when the user has none yet. */
  tabs: Saved<unknown> | null;
}

export async function loadShell(caller: Caller): Promise<ShellData> {
  const deps = processDeps();
  await registrySynced();
  const { claims } = caller;
  const keys = shellAccessKeys(deps.registry);
  const [profile, entitledKeys, runnable, prefs, t] = await Promise.all([
    callerProfile(deps.sql, claims),
    Promise.all(keys.entitlements.map(async (key) => ((await entitled(deps.sql, claims.active_company_id, key)) ? key : null))),
    runnableProcesses(deps.sql, deps.registry, claims, keys.processes),
    // A plain read under RLS, not a process: no audit row on every page load.
    readUserPrefs(deps.sql, claims, ["theme", "tabs", "assistant.open"]),
    getTranslations(),
  ]);
  // A membership the admin deactivated (design §22.16) opens nothing: the layout signs the session out.
  if (!profile.active) throw new Unauthenticated("account_disabled");
  const theme = savedFrom(prefs.theme);
  const assistantOpen = savedFrom(prefs["assistant.open"]);
  const shell = buildShellNav(deps.registry, { entitled: new Set(entitledKeys.filter((k): k is string => k !== null)), runnable });

  const commands: CommandItem[] = shell.creates
    .filter((create) => t.has(create.labelKey))
    .map((create) => ({ id: `create:${create.processId}`, label: t("nav.shell.palette.create", { entity: t(create.labelKey) }), kind: "create", href: create.href }));

  const assistantColumns = await loadAssistantColumns(deps, caller, (key) => (t.has(key) ? t(key) : key));

  const company = profile.companies.find((c) => c.id === claims.active_company_id) ?? { id: claims.active_company_id, name: "", taxId: null };
  return {
    company,
    companies: profile.companies,
    user: { id: profile.user.id, name: profile.user.name, email: profile.user.email, roles: profile.roles },
    modules: shell.modules,
    nav: shell.nav,
    commands,
    assistantColumns,
    theme: theme && isThemeMode(theme.value) ? { value: theme.value, savedAt: theme.savedAt } : null,
    assistantOpen: assistantOpen && typeof assistantOpen.value === "boolean" ? { value: assistantOpen.value, savedAt: assistantOpen.savedAt } : null,
    tabs: savedFrom(prefs.tabs),
  };
}

/**
 * The shell data of this request, loaded once: the layout needs it for the shell and a page (the home) for what it offers
 * (menu items, the user's name, the company's zone). Within one render React hands every caller the same answer.
 */
export const loadShellOnce = cache(async (): Promise<ShellData> => loadShell(await requireCaller()));
