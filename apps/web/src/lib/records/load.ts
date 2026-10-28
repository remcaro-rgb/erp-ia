import { getLocale, getTranslations } from "next-intl/server";
import { gridPageAccess, ProcessError, runGridQuery, runnableProcesses, runProcess, type Caller, type FieldMode } from "@erp/kernel";
import type { CategoryOption, GridColumn, PartyTables, ProductTables } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { gridDenial, gridEntity } from "@/lib/grid/access";
import { buildColumns } from "@/lib/grid/columns";
import { presentationOf } from "@/lib/grid/presentation";
import { processDeps } from "@/lib/server/runtime";
import { NEW_RECORD_ID, recordEntity, type RecordEntity } from "./entities";
import { partyTables, productTables } from "./tables";

// Server-side loading of one record for the full-page frame. Every read is a consult process (or the grid query) run
// as the session's user, so company RLS, the party scope, field masking and roles_view apply exactly as in the grid.
// `/r/<entity>/new` loads no record: the empty form, for a caller who may create.

/** What the Datos form of each entity needs besides the record. */
export type FormData =
  | { kind: "party"; tables: PartyTables }
  | {
      kind: "product";
      tables: ProductTables;
      categories: CategoryOption[];
      supplier: { fields: GridColumn[]; label: string | null; entityLabel: string };
    }
  | { kind: "category"; tables: ProductTables; productCount: number };

export interface LoadedRecord {
  entity: RecordEntity;
  caller: Caller;
  /** Null for a new record. */
  record: (Record<string, unknown> & { id: string }) | null;
  defs: Awaited<ReturnType<typeof customFields>>;
  contacts: Awaited<ReturnType<typeof contacts>>;
  /** The caller's mode of each field of the entity. */
  modes: Record<string, FieldMode>;
  /** The caller may run the save process (create for a new record, update otherwise). */
  canSave: boolean;
  form: FormData;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const customFields = (caller: Caller, entity: string) => runProcess(processDeps(), caller, "kernel.custom_field.list", { entity });
const contacts = (caller: Caller, partyId: string) => runProcess(processDeps(), caller, "core.contact.list", { partyId });

/** A side panel the caller may not read (no permission) is empty, not a failure of the page. */
async function orEmpty<T>(read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) return [];
    throw error;
  }
}

/** Rows of another entity's grid as the caller sees them; none when the caller may not read that grid. */
async function gridRows(caller: Caller, entityId: string, state: Parameters<typeof runGridQuery>[3]) {
  const deps = processDeps();
  const entity = gridEntity(deps.registry, entityId);
  if (!entity || (await gridDenial(deps, caller.claims, entity))) return { rows: [], total: 0 };
  return runGridQuery(deps.sql, caller.claims, entity, state);
}

async function formData(caller: Caller, entity: RecordEntity, record: LoadedRecord["record"]): Promise<FormData> {
  const locale = await getLocale();
  if (entity.id === "core.party") return { kind: "party", tables: partyTables(locale) };
  if (entity.id === "core.product_category") {
    const products = record
      ? await gridRows(caller, "core.product", { filters: [{ field: "category_id", op: "eq", value: record.id }], sort: [], page: 1, pageSize: 1, columns: ["seq"] })
      : { total: 0 };
    return { kind: "category", tables: productTables(), productCount: products.total };
  }
  const deps = processDeps();
  const t = await getTranslations();
  const party = gridEntity(deps.registry, "core.party")!;
  const supplierId = typeof record?.supplier_id === "string" ? record.supplier_id : null;
  const [categories, partyAccess, supplier] = await Promise.all([
    gridRows(caller, "core.product_category", { filters: [], sort: [{ field: "name", dir: "asc" }], page: 1, pageSize: 500, columns: ["name", "iva_rate", "inc_rate", "other_taxes", "default_uom", "status"] }),
    gridPageAccess(deps.sql, caller.claims, party),
    supplierId ? gridRows(caller, "core.party", { filters: [{ field: "id", op: "eq", value: supplierId }], sort: [], page: 1, pageSize: 1, columns: ["legal_name"] }) : null,
  ]);
  return {
    kind: "product",
    tables: productTables(),
    categories: categories.rows.map((c) => ({
      id: String(c.id),
      name: String(c.name ?? ""),
      ivaRate: String(c.iva_rate ?? ""),
      incRate: c.inc_rate === null || c.inc_rate === undefined ? null : String(c.inc_rate),
      otherTaxes: Array.isArray(c.other_taxes) ? c.other_taxes.map(String) : [],
      defaultUom: c.default_uom === null || c.default_uom === undefined ? null : String(c.default_uom),
      active: c.status !== "inactive",
    })),
    supplier: {
      fields: buildColumns(party, partyAccess, presentationOf(party.id), (key) => t(key)),
      label: supplier?.rows[0] ? String(supplier.rows[0].legal_name ?? supplierId) : null,
      entityLabel: t(party.label),
    },
  };
}

/**
 * The record `/r/<entity>/<id>` shows, or null when the entity has no full page, the id is neither a UUID nor `new`,
 * the record does not exist for the caller (a hidden record looks like a missing one), or `new` is asked by a caller
 * who may not create. Throws `Unauthenticated` without a complete session; the page turns that into a redirect.
 */
export async function loadRecord(entityId: string, id: string): Promise<LoadedRecord | null> {
  const entity = recordEntity(entityId);
  if (!entity || (id !== NEW_RECORD_ID && !UUID.test(id))) return null;
  const caller = await requireCaller();
  const deps = processDeps();
  const registered = gridEntity(deps.registry, entity.id);
  if (!registered) return null;

  let record: LoadedRecord["record"] = null;
  if (id !== NEW_RECORD_ID) {
    try {
      record = (await runProcess(deps, caller, entity.consult, { id })) as LoadedRecord["record"];
    } catch (error) {
      if (error instanceof ProcessError && ["not_found", "forbidden", "not_entitled"].includes(error.code)) return null;
      throw error;
    }
  }
  const saveProcess = record ? entity.update : entity.create;
  const [defs, partyContacts, access, runnable] = await Promise.all([
    record ? orEmpty(customFields(caller, entity.id)) : Promise.resolve([]),
    record && entity.id === "core.party" ? orEmpty(contacts(caller, record.id)) : Promise.resolve([]),
    gridPageAccess(deps.sql, caller.claims, registered),
    runnableProcesses(deps.sql, deps.registry, caller.claims, [saveProcess]),
  ]);
  const canSave = runnable.has(saveProcess);
  if (!record && !canSave) return null;
  return { entity, caller, record, defs, contacts: partyContacts, modes: access.modes, canSave, form: await formData(caller, entity, record) };
}
