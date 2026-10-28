import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { gridPageAccess, ProcessError, runGridQuery, runnableProcesses, runProcess, type Caller, type ResolvedEntityDef } from "@erp/kernel";
import type { GridColumn, PartyScope, SavedViewItem } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { recordEntity } from "@/lib/records/entities";
import { gridTables } from "@/lib/records/tables";
import { processDeps } from "@/lib/server/runtime";
import { gridDenial, gridEntity, type GridDenial } from "./access";
import { buildColumns, type CodeTables } from "./columns";
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
  /** "Crear <entity>": the title of the new record's tab. */
  newTitle: string;
  /** Column that names a record in its tab. */
  titleField: string;
}

/** The process a mass import runs (Task 13b). */
const IMPORT_PROCESS = "kernel.import.run";

export type GridPageResult = { ok: true; data: GridPageData } | { ok: false; denial: GridDenial };

/** The company's categories as options (id → name), read through the masked view like any grid. */
async function categoryOptions(caller: Caller): Promise<{ value: string; label: string }[]> {
  const deps = processDeps();
  const categories = gridEntity(deps.registry, "core.product_category");
  if (!categories || (await gridDenial(deps, caller.claims, categories))) return [];
  const { rows } = await runGridQuery(deps.sql, caller.claims, categories, { filters: [], sort: [{ field: "name", dir: "asc" }], page: 1, pageSize: 500, columns: ["name"] });
  return rows.map((r) => ({ value: String(r.id), label: String(r.name ?? r.id) }));
}

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
  const items = deps.registry.modules().flatMap((m) => [...m.navigation, ...m.features.flatMap((f) => f.nav ?? [])]);
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
  const [access, views, runnable, t, locale, categories] = await Promise.all([
    gridPageAccess(deps.sql, caller.claims, entity),
    savedViews(caller, entity.id),
    runnableProcesses(deps.sql, deps.registry, caller.claims, record ? [record.create, IMPORT_PROCESS] : []),
    getTranslations(),
    getLocale(),
    entity.id === "core.product" ? categoryOptions(caller) : Promise.resolve([]),
  ]);
  const tables: CodeTables = { ...gridTables(locale), categories };
  return {
    ok: true,
    data: {
      entity: entity.id,
      title: t(screenLabel(deps, href, entity.label)),
      columns: buildColumns(entity, access, presentationOf(entity.id), (key) => t(key), tables),
      partyScope: entity.id === "core.party" ? access.partyScope : null,
      views,
      canCreate: record ? runnable.has(record.create) : false,
      canImport: record ? runnable.has(record.create) && runnable.has(IMPORT_PROCESS) : false,
      newTitle: record ? t("grid.record_title.new", { entity: t(record.nounKey) }) : "",
      titleField: record?.titleField ?? entity.displayField,
    },
  };
}
