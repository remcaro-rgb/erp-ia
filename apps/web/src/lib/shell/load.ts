import "server-only";
import { getTranslations } from "next-intl/server";
import { callerProfile, entitled, readUserPrefs, runnableProcesses, type Caller } from "@erp/kernel";
import { isThemeMode, type CommandItem, type ResultColumn, type NavItem, type Saved, type ShellCompany, type ShellModule, type ShellUser, type ThemeMode } from "@erp/ui";
import { gridEntities } from "@/lib/grid/hrefs";
import { savedFrom } from "@/lib/prefs/validate";
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
  /** The saved theme in the active company, or null. */
  theme: Saved<ThemeMode> | null;
  /** Labels and types of the fields of each entity with a grid, for the assistant's result tables. */
  assistantColumns: Record<string, ResultColumn[]>;
  /** The saved tabs as stored (the shell repairs them), or null when the user has none yet. */
  tabs: Saved<unknown> | null;
}

export async function loadShell(caller: Caller): Promise<ShellData> {
  const deps = processDeps();
  const { claims } = caller;
  const keys = shellAccessKeys(deps.registry);
  const [profile, entitledKeys, runnable, prefs, t] = await Promise.all([
    callerProfile(deps.sql, claims),
    Promise.all(keys.entitlements.map(async (key) => ((await entitled(deps.sql, claims.active_company_id, key)) ? key : null))),
    runnableProcesses(deps.sql, deps.registry, claims, keys.processes),
    // A plain read under RLS, not a process: no audit row on every page load.
    readUserPrefs(deps.sql, claims, ["theme", "tabs"]),
    getTranslations(),
  ]);
  const theme = savedFrom(prefs.theme);
  const shell = buildShellNav(deps.registry, { entitled: new Set(entitledKeys.filter((k): k is string => k !== null)), runnable });

  const commands: CommandItem[] = shell.creates
    .filter((create) => t.has(create.labelKey))
    .map((create) => ({ id: `create:${create.processId}`, label: t("nav.shell.palette.create", { entity: t(create.labelKey) }), kind: "create", href: create.href }));

  // Metadata only (names and types of registered fields): what a result shows is decided by the query's own masking.
  const assistantColumns = Object.fromEntries(
    gridEntities().flatMap((id) => {
      const entity = deps.registry.entities().find((e) => e.id === id);
      return entity ? [[id, entity.fields.map((field): ResultColumn => ({ field: field.name, label: t.has(field.label) ? t(field.label) : field.name, type: field.type }))]] : [];
    }),
  );

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
    tabs: savedFrom(prefs.tabs),
  };
}
