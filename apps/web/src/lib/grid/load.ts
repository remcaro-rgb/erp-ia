import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { flattenNav, gridPageAccess, ProcessError, runnableProcesses, runProcess, withClaims, type Caller, type ResolvedEntityDef } from "@erp/kernel";
import type { GridColumn, PartyScope, SavedGridState, SavedViewItem } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { recordEntity } from "@/lib/records/entities";
import { gridTables } from "@/lib/records/tables";
import { processDeps } from "@/lib/server/runtime";
import { gridDenial, gridEntity, type GridDenial } from "./access";
import { categoryOptions } from "./options";
import { defaultMovementsState, type MovementsPeriod } from "./movements";
import { buildColumns, type CodeTables } from "./columns";
import { linkableEntities, refTargets } from "./links";
import { presentationOf } from "./presentation";

// What a grid page (Terceros, Productos, Categorías) needs, read as the caller (design §9): the columns with the
// caller's field modes, the party scope for the switches, the user's saved views and whether they may create.

export interface GridPageData {
  entity: string;
  /** The screen's name for the grid header (its menu label, "Terceros"). */
  title: string;
  columns: GridColumn[];
  /** The caller's party scope (parties only). */
  partyScope: PartyScope | null;
  views: SavedViewItem[];
  canCreate: boolean;
  /** The caller may import into the entity (kernel.import.run and its create process). */
  canImport: boolean;
  /** Imprimir: a maestro or documento whose list the caller may print (kernel.doc_template.print, Task 16). */
  canPrint: boolean;
  /** A documento imports from Excel only (two sheets: header and lines); its import dialog offers no CSV template. */
  xlsxOnly: boolean;
  /** "Crear <entity>": the title of the new record's tab. */
  newTitle: string;
  /** Column that names a record in its tab. */
  titleField: string;
  /** Where the grid starts when the user has no default view and the link carries no query (the entity's default state). */
  initialState?: SavedGridState;
}

type DefaultStates = (caller: Caller, deps: ReturnType<typeof processDeps>) => Promise<SavedGridState | undefined>;

/** The period Movimientos opens on: the open one holding today, else the latest open one; none when every period is closed. */
async function openPeriod(deps: ReturnType<typeof processDeps>, caller: Caller): Promise<MovementsPeriod | null> {
  const [row] = await withClaims(deps.sql, caller.claims, (tx) =>
    tx<{ starts_on: string; ends_on: string }[]>`
      select starts_on::text, ends_on::text from accounting.v_periods
      where status = 'open'
      order by (current_date between starts_on and ends_on) desc, starts_on desc
      limit 1`,
  );
  return row ? { startsOn: row.starts_on, endsOn: row.ends_on } : null;
}

/**
 * Per-entity default state: an entity whose grid should not open unfiltered says where it starts. The user's own default
 * view and a link's query win over it.
 */
const ENTITY_DEFAULT_STATES: Record<string, DefaultStates> = {
  "accounting.ledger_line": async (caller, deps) => {
    const [period, settings] = await Promise.all([
      openPeriod(deps, caller),
      runProcess(deps, caller, "accounting.settings.consult", {}).catch((error: unknown) => {
        // A caller who may not read the settings still gets the grid, with the dimensions that are off by default.
        if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) return null;
        throw error;
      }),
    ]);
    const uses = settings as { useOpenAuxiliaries?: boolean; useItems?: boolean; useBusinessUnits?: boolean } | null;
    return defaultMovementsState(period, { openAuxiliaries: uses?.useOpenAuxiliaries, items: uses?.useItems, businessUnits: uses?.useBusinessUnits });
  },
};

/** The process a mass import runs (Task 13b). */
const IMPORT_PROCESS = "kernel.import.run";
const PRINT_PROCESS = "kernel.doc_template.print";

export type GridPageResult = { ok: true; data: GridPageData } | { ok: false; denial: GridDenial };

/** The user's saved views of the entity; none when their role may not list them. */
async function savedViews(caller: Caller, entity: string): Promise<SavedViewItem[]> {
  try {
    return await runProcess(processDeps(), caller, "kernel.saved_view.list", { entity });
  } catch (error) {
    if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) return [];
    throw error;
  }
}

/** The menu label of the screen at `href` (plural: "Terceros"), or the entity's own label. */
function screenLabel(deps: ReturnType<typeof processDeps>, href: string, fallback: string): string {
  const items = deps.registry.modules().flatMap((m) => flattenNav([...m.navigation, ...m.features.flatMap((f) => f.nav ?? [])]));
  return items.find((item) => item.href === href)?.label ?? fallback;
}

/** The grid page of `entityId`, shown at `href` (its menu item names the grid). */
export async function loadGridPage(entityId: string, href: string): Promise<GridPageResult> {
  const caller = await requireCaller();
  const deps = processDeps();
  const entity: ResolvedEntityDef | null = gridEntity(deps.registry, entityId);
  if (!entity) return { ok: false, denial: "not_found" };
  const denial = await gridDenial(deps, caller.claims, entity);
  if (denial) return { ok: false, denial };

  const record = recordEntity(entity.id);
  const [access, views, runnable, t, locale, categories, linkable, initialState] = await Promise.all([
    gridPageAccess(deps.sql, caller.claims, entity),
    savedViews(caller, entity.id),
    runnableProcesses(deps.sql, deps.registry, caller.claims, [...(record ? [record.create, IMPORT_PROCESS] : []), PRINT_PROCESS]),
    getTranslations(),
    getLocale(),
    entity.id === "core.product" ? categoryOptions(caller) : Promise.resolve([]),
    linkableEntities(deps, caller.claims, refTargets(entity)),
    ENTITY_DEFAULT_STATES[entity.id]?.(caller, deps),
  ]);
  const tables: CodeTables = { ...gridTables(locale), categories };
  return {
    ok: true,
    data: {
      entity: entity.id,
      title: t(screenLabel(deps, href, entity.label)),
      columns: buildColumns(entity, access, presentationOf(entity.id), (key) => t(key), tables, linkable),
      partyScope: entity.id === "core.party" ? access.partyScope : null,
      views,
      canCreate: record ? runnable.has(record.create) : false,
      canImport: record ? runnable.has(record.create) && runnable.has(IMPORT_PROCESS) : false,
      canPrint: (entity.entityType === "maestro" || entity.entityType === "documento") && runnable.has(PRINT_PROCESS),
      xlsxOnly: entity.entityType === "documento",
      newTitle: record ? t("grid.record_title.new", { entity: t(record.nounKey) }) : "",
      titleField: record?.titleField ?? entity.displayField,
      ...(initialState ? { initialState } : {}),
    },
  };
}
