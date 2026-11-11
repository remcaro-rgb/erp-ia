import "server-only";
import { cache } from "react";
import { getTranslations } from "next-intl/server";
import { callerProfile, entitled, flattenNav, menuHiddenKeys, openRecommendations, readUserPrefs, runnableProcesses, withClaims, type Caller, type RunProcessDeps } from "@erp/kernel";
import { isThemeMode, type CommandItem, type MfaState, type RecommendationItem, type ResultColumn, type NavItem, type Saved, type ShellCompany, type ShellModule, type ShellUser, type ThemeMode } from "@erp/ui";
import { recommendationItem } from "@/lib/home/shape";
import { assertComplete, getSessionState, Unauthenticated, type SessionState } from "@/lib/auth/claims";
import { savedFrom } from "@/lib/prefs/validate";
import { processDeps, registrySynced } from "@/lib/server/runtime";
import { hasOptionalMasters, hasPostingItem, hideOptionalMasters, readOptionalMasters, readPendingPostings, withPostingBadge } from "@/lib/accounting/nav";
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
  /** The caller's second step, for "Verificación en dos pasos" in the user menu (design §22.19). */
  mfa: MfaState;
  /** The bell (plan 2B Task 38): the caller's open recommendations and the five newest, or null when they may not list them. */
  notifications: { total: number; items: RecommendationItem[] } | null;
}

/** How many recommendations the bell's menu lists (the newest); the dot counts every open one. */
export const BELL_ITEMS = 5;

/**
 * The bell's content, as the caller: a plain read under RLS (kernel.v_recommendations masks the params and the subject), not the list
 * process, so a page load writes no audit row; gated on the list process as the inbox is.
 */
async function readNotifications(deps: RunProcessDeps, caller: Caller): Promise<{ total: number; recommendations: Awaited<ReturnType<typeof openRecommendations>>["recommendations"] } | null> {
  return withClaims(deps.sql, caller.claims, async (tx) => {
    const [gate] = await tx<{ allowed: boolean }[]>`select kernel.can_run_process('kernel.recommendation.list') as allowed`;
    if (!gate?.allowed) return null;
    return openRecommendations(tx, { companyId: caller.claims.active_company_id, locale: caller.claims.locale, limit: BELL_ITEMS });
  });
}

/**
 * The caller's second step: enrolled from the session's claim (the hook reads the auth schema); whether a role requires
 * it from `kernel.user_requires_mfa`, the very predicate kernel.user.mfa.disable refuses on (any active membership an
 * administrator set to require it, owner decision 2026-11-04; it answers only about the caller).
 */
async function readMfa(sql: RunProcessDeps["sql"], caller: Caller, enrolled: boolean): Promise<MfaState> {
  const [row] = await withClaims(sql, caller.claims, (tx) =>
    tx<{ required: boolean }[]>`select kernel.user_requires_mfa(${caller.claims.sub}) as required`,
  );
  return { enrolled, required: row?.required === true };
}

export async function loadShell(caller: Caller, session: Pick<SessionState, "mfaEnrolled">): Promise<ShellData> {
  const deps = processDeps();
  await registrySynced();
  const { claims } = caller;
  const keys = shellAccessKeys(deps.registry);
  const [profile, entitledKeys, runnable, hidden, prefs, t, mfa, inbox] = await Promise.all([
    callerProfile(deps.sql, claims),
    Promise.all(keys.entitlements.map(async (key) => ((await entitled(deps.sql, claims.active_company_id, key)) ? key : null))),
    runnableProcesses(deps.sql, deps.registry, claims, keys.processes),
    // The menu items the company's rules hide for the caller (entity types spec §9.2); none for an admin.
    menuHiddenKeys(deps.sql, claims),
    // A plain read under RLS, not a process: no audit row on every page load.
    readUserPrefs(deps.sql, claims, ["theme", "tabs", "assistant.open"]),
    getTranslations(),
    readMfa(deps.sql, caller, session.mfaEnrolled),
    // The bell never takes the shell down: a failed read draws it empty.
    readNotifications(deps, caller).catch((error: unknown) => {
      console.error("shell notifications failed", error);
      return null;
    }),
  ]);
  // A membership the admin deactivated (design §22.16) opens nothing: the layout signs the session out.
  if (!profile.active) throw new Unauthenticated("account_disabled");
  const theme = savedFrom(prefs.theme);
  const assistantOpen = savedFrom(prefs["assistant.open"]);
  const shell = buildShellNav(deps.registry, { entitled: new Set(entitledKeys.filter((k): k is string => k !== null)), runnable, hidden });
  // The optional analytic masters of the accounting module follow the company's settings (accounting design §8).
  const shown = hasOptionalMasters(shell.nav) ? hideOptionalMasters(shell.nav, await readOptionalMasters(deps.sql, claims)) : shell.nav;
  // Reglas contables shows how many events are waiting to be posted.
  const nav = hasPostingItem(shown) ? withPostingBadge(shown, await readPendingPostings(deps.sql, deps.registry, claims)) : shown;

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
    nav,
    commands,
    assistantColumns,
    theme: theme && isThemeMode(theme.value) ? { value: theme.value, savedAt: theme.savedAt } : null,
    assistantOpen: assistantOpen && typeof assistantOpen.value === "boolean" ? { value: assistantOpen.value, savedAt: assistantOpen.savedAt } : null,
    tabs: savedFrom(prefs.tabs),
    mfa,
    notifications: inbox ? { total: inbox.total, items: inbox.recommendations.map((r) => recommendationItem(deps.registry, flattenNav(nav), r)) } : null,
  };
}

/**
 * The shell data of this request, loaded once: the layout needs it for the shell and a page (the home) for what it offers
 * (menu items, the user's name, the company's zone). Within one render React hands every caller the same answer.
 */
export const loadShellOnce = cache(async (): Promise<ShellData> => {
  // The session itself, not only its claims: the shell also shows whether the second step is on.
  const session = await getSessionState();
  return loadShell({ claims: assertComplete(session), origin: "ui" }, session!);
});
