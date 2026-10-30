import "server-only";
import { getTranslations } from "next-intl/server";
import { entitled, gridPageAccess, ProcessError, runnableProcesses, runProcess, type Caller, type GridStateInput } from "@erp/kernel";
import type { GridColumn } from "@erp/ui";
import { gridEntity } from "@/lib/grid/access";
import { buildColumns } from "@/lib/grid/columns";
import { presentationOf } from "@/lib/grid/presentation";
import { processDeps } from "@/lib/server/runtime";
import { contributionProcesses, resolveContributedTabs, type ContributedTab } from "./contributed";

// The tabs other modules contribute to a record page, loaded as the caller (rule 4, design §5.16): the manifest decides
// which tabs a record may show, the source views and the mapping process answer for the caller's rights, and what the tab
// draws (columns of the source grid, the lookup's fields and the stored choices) is read here once for the page.

/** A mapping role's current choice, as the lookup box shows it. */
export interface MappingChoice {
  id: string;
  label: string;
}

export interface LoadedContribution extends ContributedTab {
  /** grid: the source view's columns with the caller's field modes. */
  gridColumns?: GridColumn[];
  /** grid: the source entity's label key for the grid header. */
  gridTitle?: string;
  /** mapping: what the lookups need. */
  lookup?: { columns: GridColumn[]; entity: string; entityLabel: string; displayField: string };
  /** mapping: the stored choice of each role (null: none). */
  values?: Record<string, MappingChoice | null>;
}

/** How a record of the lookup entity reads: its display field and, when it has one, its name (`1105 — Caja`). */
export const lookupLabel = (row: Record<string, unknown>, displayField: string): string => {
  const main = String(row[displayField] ?? "");
  const name = typeof row.name === "string" && displayField !== "name" ? row.name : "";
  return name ? `${main} — ${name}` : main;
};

const refusal = (error: unknown): boolean => error instanceof ProcessError && ["forbidden", "not_entitled", "not_found"].includes(error.code);

/** The stored choices of `dimension`'s roles from the contribution's consult process; none when the caller may not consult. */
async function storedChoices(caller: Caller, tab: NonNullable<ContributedTab["mapping"]>, labelOf: (id: string) => Promise<string | null>): Promise<Record<string, MappingChoice | null>> {
  const values: Record<string, MappingChoice | null> = Object.fromEntries(tab.roles.map((role) => [role, null]));
  if (!tab.consultProcess) return values;
  let stored: unknown;
  try {
    stored = await runProcess(processDeps(), caller, tab.consultProcess, {});
  } catch (error) {
    if (refusal(error)) return values;
    throw error;
  }
  const mappings = (stored as { mappings?: Array<{ role?: string; dimension?: string | null; accountId?: string | null }> } | null)?.mappings ?? [];
  for (const role of tab.roles) {
    const found = mappings.find((m) => m.role === role && (m.dimension ?? null) === tab.dimension && typeof m.accountId === "string");
    const label = found?.accountId ? await labelOf(found.accountId) : null;
    if (found?.accountId && label !== null) values[role] = { id: found.accountId, label };
  }
  return values;
}

/**
 * The contributed tabs of the record, with what each draws. A tab whose entities the caller may not read is left out
 * (a grid with no readable source never counted rows; a mapping whose lookup entity is closed shows read-only text).
 */
export async function loadContributedTabs(
  caller: Caller,
  entityId: string,
  recordId: string,
  gridRows: (caller: Caller, entity: string, state: GridStateInput) => Promise<{ rows: Record<string, unknown>[]; total: number }>,
): Promise<LoadedContribution[]> {
  const deps = processDeps();
  if (deps.registry.recordTabsFor(entityId).length === 0) return [];
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, contributionProcesses(deps.registry, entityId));
  const tabs = await resolveContributedTabs(deps.registry, entityId, recordId, {
    entitled: (feature) => entitled(deps.sql, caller.claims.active_company_id, `feature:${feature}`),
    rowCount: async (source, filters) => {
      const entity = gridEntity(deps.registry, source);
      if (!entity) return null;
      return (await gridRows(caller, source, { filters, sort: [], page: 1, pageSize: 1 })).total;
    },
    runnable,
  });
  if (tabs.length === 0) return [];

  const t = await getTranslations();
  const columnsOf = async (entityName: string): Promise<{ columns: GridColumn[]; label: string; displayField: string } | null> => {
    const entity = gridEntity(deps.registry, entityName);
    if (!entity) return null;
    const access = await gridPageAccess(deps.sql, caller.claims, entity);
    return { columns: buildColumns(entity, access, presentationOf(entity.id), (key) => t(key)), label: entity.label, displayField: entity.displayField };
  };

  return Promise.all(
    tabs.map(async (tab): Promise<LoadedContribution> => {
      if (tab.kind === "grid") {
        const source = await columnsOf(tab.source!);
        return { ...tab, ...(source ? { gridColumns: source.columns, gridTitle: source.label } : {}) };
      }
      const mapping = tab.mapping!;
      const lookup = await columnsOf(mapping.lookupEntity);
      const labelOf = async (id: string) => {
        if (!lookup) return null;
        const page = await gridRows(caller, mapping.lookupEntity, { filters: [{ field: "id", op: "eq", value: id }], sort: [], page: 1, pageSize: 1 });
        return page.rows[0] ? lookupLabel(page.rows[0], lookup.displayField) : null;
      };
      return {
        ...tab,
        ...(lookup ? { lookup: { columns: lookup.columns, entity: mapping.lookupEntity, entityLabel: lookup.label, displayField: lookup.displayField } } : {}),
        values: await storedChoices(caller, mapping, labelOf),
      };
    }),
  );
}
