import "server-only";
import { masterTree, type MasterTree } from "@erp/module-accounting";
import { readUserPrefs, runnableProcesses, withClaims, type Caller } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { loadGridPage, type GridPageData } from "@/lib/grid/load";
import type { GridDenial } from "@/lib/grid/access";
import { processDeps } from "@/lib/server/runtime";
import { masterPage, masterViewKey, parseMasterView, type MasterView } from "./masters";

// What the analytic master page needs, read as the caller (accounting design §8): the grid of the entity, the Tabla · Árbol
// choice the user made, the periods for the selector and, when the page opens on the tree, its nodes with the period's figure.

/** The process a mass import runs (Task 13b). */
const IMPORT_PROCESS = "kernel.import.run";

export interface PeriodOption {
  id: string;
  startsOn: string;
  endsOn: string;
  status: string;
}

export interface MasterPageData {
  grid: GridPageData;
  figure: "balance" | "result" | "movement";
  view: MasterView;
  periods: PeriodOption[];
  periodId: string | null;
  /** The tree of the default period when the page opens on it; otherwise the page asks for it on the first switch. */
  tree: MasterTree | null;
}

export type MasterPageResult = { ok: true; data: MasterPageData } | { ok: false; denial: GridDenial };

/** The periods of the company, newest first, and the one the selector starts on: the open one holding today, else the latest open, else the latest. */
export async function periodOptions(caller: Caller): Promise<{ periods: PeriodOption[]; current: string | null }> {
  const rows = await withClaims(processDeps().sql, caller.claims, (tx) =>
    tx<{ id: string; starts_on: string; ends_on: string; status: string; today: boolean }[]>`
      select id, starts_on::text, ends_on::text, status, (current_date between starts_on and ends_on) as today
      from accounting.v_periods where company_id = ${caller.claims.active_company_id} order by starts_on desc`,
  );
  const periods = rows.map((r) => ({ id: r.id, startsOn: r.starts_on, endsOn: r.ends_on, status: r.status }));
  const current = rows.find((r) => r.today && r.status === "open") ?? rows.find((r) => r.status === "open") ?? rows[0];
  return { periods, current: current?.id ?? null };
}

/** The nodes of `entity` with the figure of `periodId`, read as the caller. */
export async function loadMasterTree(caller: Caller, entity: string, periodId: string | null): Promise<MasterTree> {
  const master = masterPage(entity);
  if (!master) throw new Error(`${entity} has no tree`);
  return withClaims(processDeps().sql, caller.claims, (tx) =>
    masterTree(tx, { entity: master.entity as Parameters<typeof masterTree>[1]["entity"], companyId: caller.claims.active_company_id, periodId }),
  );
}

/** The master page of `entityId` shown at `href`. */
export async function loadMasterPage(entityId: string, href: string): Promise<MasterPageResult> {
  const master = masterPage(entityId);
  if (!master) return { ok: false, denial: "not_found" };
  const caller = await requireCaller();
  const deps = processDeps();
  const base = await loadGridPage(entityId, href);
  if (!base.ok) return base;
  const [runnable, prefs, { periods, current }] = await Promise.all([
    runnableProcesses(deps.sql, deps.registry, caller.claims, [master.create, IMPORT_PROCESS]),
    readUserPrefs(deps.sql, caller.claims, [masterViewKey(entityId)]),
    periodOptions(caller),
  ]);
  const view = parseMasterView(prefs[masterViewKey(entityId)]?.value);
  const tree = view === "tree" ? await loadMasterTree(caller, entityId, current) : null;
  return {
    ok: true,
    data: {
      grid: {
        ...base.data,
        canCreate: runnable.has(master.create),
        canImport: runnable.has(master.create) && runnable.has(IMPORT_PROCESS),
      },
      figure: master.figure,
      view,
      periods,
      periodId: current,
      tree,
    },
  };
}
