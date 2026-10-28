import { importColumns, type Registry } from "@erp/kernel";
import { recordEntity } from "@/lib/records/entities";

// The entities the import page offers (design §9, prototype `renderImportPage`): the grid screens with an
// importable entity, for a caller who may run kernel.import.run and the entity's create process. Pure.

/** The process a mass import runs. */
export const IMPORT_PROCESS = "kernel.import.run";

/** The grid screens that import: the entity and the screen whose menu label names it. */
export const IMPORT_SCREENS: readonly { entity: string; href: string }[] = [
  { entity: "core.party", href: "/parties" },
  { entity: "core.product", href: "/products" },
  { entity: "core.product_category", href: "/categories" },
];

export interface ImportScreen {
  entity: string;
  href: string;
  /** `<schema>.<table>`, as the prototype's card shows it. */
  table: string;
  columns: number;
}

/** The processes to ask permission for. */
export const importScreenProcesses = (): string[] => [IMPORT_PROCESS, ...IMPORT_SCREENS.flatMap((s) => recordEntity(s.entity)?.create ?? [])];

/** The screens of registered entities whose create process and kernel.import.run the caller may run. */
export function importScreens(registry: Registry, runnable: ReadonlySet<string>): ImportScreen[] {
  if (!runnable.has(IMPORT_PROCESS)) return [];
  return IMPORT_SCREENS.flatMap(({ entity, href }) => {
    const record = recordEntity(entity);
    const def = registry.entities().find((e) => e.id === entity);
    if (!record || !def || !runnable.has(record.create)) return [];
    return [{ entity, href, table: `${def.schema}.${def.table}`, columns: importColumns(registry, entity).length }];
  });
}
