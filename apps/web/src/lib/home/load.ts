import "server-only";
import { flattenNav, gridEntity, ProcessError, readUserPrefs, runProcess, type Caller, type Kpi } from "@erp/kernel";
import type { HelpShortcut, RecentRecord, RecommendationItem, Saved } from "@erp/ui";
import { savedFrom } from "@/lib/prefs/validate";
import { processDeps } from "@/lib/server/runtime";
import type { ShellData } from "@/lib/shell/load";
import { helpShortcuts, recentHref } from "./shape";

// Everything the home screen shows, read as the caller through the registered processes (design §19a, §7.5): the KPIs of
// the modules the company has, the recommendations inbox, the records they touched last and their saved layout. A widget
// whose process the caller may not run (no permission, module not contracted) comes back null and is not drawn.

export type GreetingPeriod = "morning" | "afternoon" | "evening";

export interface HomeData {
  greeting: { period: GreetingPeriod; name: string };
  kpis: Kpi[] | null;
  recommendations: RecommendationItem[] | null;
  recent: RecentRecord[] | null;
  help: HelpShortcut[];
  /** The saved `home_layout` as stored (the dashboard validates it), or null. */
  layout: Saved<unknown> | null;
  /** When the snapshot was read (ISO): the widgets say "Actualizado hh:mm". */
  asOf: string;
}

/** Morning from five to noon, afternoon until six, evening (and the small hours) after, by the clock in the company's time zone. */
export function greetingPeriod(now: Date, timeZone: string): GreetingPeriod {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  return hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";
}

/** The first word of the name (the e-mail's local part when the profile has no name). */
export function firstNameOf(name: string): string {
  const base = name.includes("@") ? name.split("@")[0]! : name;
  return base.trim().split(/\s+/)[0] ?? name;
}

/** A widget's data, or null when the caller may not have it. Other failures are logged: one widget never takes the page down. */
async function allowed<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ProcessError) {
      if (error.code !== "forbidden" && error.code !== "not_entitled") console.error("home widget failed", error);
      return null;
    }
    throw error;
  }
}

interface RecommendationOut {
  recommendations: { id: string; agentProfile: string; title: string; body: string; confidence: number | null; suggestedActions: RecommendationItem["suggestedActions"] }[];
}
interface RecentOut {
  records: { entity: string; entityLabel: string; id: string; title: string | null; action: "insert" | "update"; at: string }[];
}

export async function loadHome(shell: ShellData, caller: Caller, now: Date = new Date()): Promise<HomeData> {
  const deps = processDeps();
  const run = <T>(id: string, input: unknown = {}) => allowed(() => runProcess(deps, caller, id, input) as Promise<T>);
  const [kpis, recommendations, recent, prefs] = await Promise.all([
    run<{ kpis: Kpi[] }>("kernel.home.kpis"),
    run<RecommendationOut>("kernel.recommendation.list"),
    run<RecentOut>("kernel.home.recent"),
    // A plain read under RLS, not a process: the layout is the user's own and is read on every visit.
    readUserPrefs(deps.sql, caller.claims, ["home_layout"]),
  ]);
  return {
    greeting: { period: greetingPeriod(now, shell.company.timeZone ?? "America/Bogota"), name: firstNameOf(shell.user.name) },
    kpis: kpis?.kpis ?? null,
    recommendations: recommendations?.recommendations.map(({ id, agentProfile, title, body, confidence, suggestedActions }) => ({ id, agentProfile, title, body, confidence, suggestedActions })) ?? null,
    recent: recent?.records.map((r) => ({ ...r, href: recentHref(gridEntity(deps.registry, r.entity), r.id) })) ?? null,
    help: helpShortcuts(flattenNav(shell.nav).map((item) => item.href)),
    layout: savedFrom(prefs.home_layout),
    asOf: now.toISOString(),
  };
}
