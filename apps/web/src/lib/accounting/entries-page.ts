import "server-only";
import { getTranslations } from "next-intl/server";
import { callerProfile, runnableProcesses, type Caller } from "@erp/kernel";
import { processDeps } from "@/lib/server/runtime";
import { periodOptions } from "./load";

// The quick filters of the Comprobantes grid (accounting design §8): Hoy · Este período · Borradores · Por aprobar · Automáticos ·
// Manuales. The dates are the company's today and the open period holding it, so the filters are plain conditions the grid can show.

export interface EntryQuickFilter {
  id: string;
  group: string;
  label: string;
  filters: { field: string; op: "eq" | "in" | "between"; value: string | string[]; value2?: string }[];
}

/** Today in the zone, as `YYYY-MM-DD`. */
export const todayIn = (timeZone: string | undefined, now = new Date()): string => new Intl.DateTimeFormat("en-CA", { dateStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(now);

export async function entryQuickFilters(caller: Caller): Promise<{ filters: EntryQuickFilter[]; canTemplate: boolean }> {
  const deps = processDeps();
  const t = await getTranslations("accounting.entry.grid");
  const [{ periods, current }, profile, runnable] = await Promise.all([
    periodOptions(caller),
    callerProfile(deps.sql, caller.claims),
    runnableProcesses(deps.sql, deps.registry, caller.claims, ["accounting.entry.from_template"]),
  ]);
  const zone = profile.companies.find((c) => c.id === caller.claims.active_company_id)?.timeZone;
  const period = periods.find((p) => p.id === current);
  const filters: EntryQuickFilter[] = [
    { id: "today", group: "date", label: t("today"), filters: [{ field: "date", op: "eq", value: todayIn(zone) }] },
    ...(period ? [{ id: "period", group: "date", label: t("period"), filters: [{ field: "date", op: "between" as const, value: period.startsOn, value2: period.endsOn }] }] : []),
    // Borradores: the states the period close counts as unfinished (Borrador, Grabado, No Aprobado), as the home card does.
    { id: "drafts", group: "status", label: t("drafts"), filters: [{ field: "status", op: "in", value: ["draft", "saved", "rejected"] }] },
    { id: "pending", group: "status", label: t("pending"), filters: [{ field: "status", op: "eq", value: "pending" }] },
    { id: "auto", group: "origin", label: t("auto"), filters: [{ field: "origin", op: "eq", value: "auto" }] },
    { id: "manual", group: "origin", label: t("manual"), filters: [{ field: "origin", op: "eq", value: "manual" }] },
  ];
  return { filters, canTemplate: runnable.has("accounting.entry.from_template") };
}
