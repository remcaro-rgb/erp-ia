import { getLocale, getTranslations } from "next-intl/server";
import {
  addRefLabels,
  GridState,
  gridPageAccess,
  ProcessError,
  refLabelKey,
  requiredTagsFor,
  runGridQuery,
  runnableProcesses,
  runProcess,
  withClaims,
  type Caller,
  type ConditionFacts,
  type EntityDef,
  type FieldMode,
  type GridStateInput,
  type RequiredTag,
} from "@erp/kernel";
import type { CategoryOption, GridColumn, PartyTables, ProductTables } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { gridDenial, gridEntity } from "@/lib/grid/access";
import { buildColumns } from "@/lib/grid/columns";
import { linkableEntities } from "@/lib/grid/links";
import { presentationOf } from "@/lib/grid/presentation";
import { processDeps } from "@/lib/server/runtime";
import { loadContributedTabs, type LoadedContribution } from "./contributed-load";
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
      supplier: { fields: GridColumn[]; label: string | null; entityLabel: string; linkable: boolean };
    }
  | { kind: "category"; tables: ProductTables; productCount: number };

/** What the caller may do on the record's tabs: each flag is the process (and, for files, the owner's update) they may run. */
export interface RecordAbilities {
  contactCreate: boolean;
  contactUpdate: boolean;
  contactDelete: boolean;
  /** Ask the external verification of a contact's e-mail or phone. */
  verify: boolean;
  /** Save datos adicionales: the entity's update process. */
  extra: boolean;
  /** Upload files and photos. */
  attach: boolean;
  /** Remove files and photos. */
  removeFile: boolean;
  /** Put the photos in order / make one principal. */
  reorder: boolean;
  /** "Sugerir foto con IA". */
  suggest: boolean;
  /** "Duplicar" (rule 37): a stored record the caller may create a copy of through the entity's create process. */
  duplicate: boolean;
}

/** A file as `kernel.attachment.list` answers it. */
export interface StoredAttachment {
  id: string;
  tag: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  position: number;
  suggested: boolean;
  uploadedBy: string | null;
  uploadedByName: string | null;
  uploadedAt: string;
}

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
  /** What the caller may do on the Contactos, Fotos, Datos adicionales and Archivos tabs. */
  can: RecordAbilities;
  /** The admin's required files that apply to this record (empty for a new one), by tag. */
  requiredTags: RequiredTag[];
  /** The record's live files in order, for the Archivos tab; null when the caller's role may not list them (not the same as no files). */
  attachments: StoredAttachment[] | null;
  /** Status of the latest verification request of each contact datum, by `<kind>:<value>` (`phone` as `+<cc><number>`). */
  verifications: Record<string, "queued" | "verified" | "failed">;
  /** The tabs other modules' manifests add to this record's page that it shows (none for a new record). */
  contributed: LoadedContribution[];
  form: FormData;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const customFields = (caller: Caller, entity: string) => runProcess(processDeps(), caller, "kernel.custom_field.list", { entity });
const contacts = (caller: Caller, partyId: string) => runProcess(processDeps(), caller, "core.contact.list", { partyId });
const attachments = (caller: Caller, entity: string, recordId: string): Promise<StoredAttachment[]> =>
  runProcess(processDeps(), caller, "kernel.attachment.list", { entity, recordId });

type ContactRow = { email: string | null; phone: string | null; phoneCc: string | null; mobile: string | null; mobileCc: string | null };

/** The data of the contacts the Verificar control asks about, as the tab keys them. */
function verifiable(rows: readonly ContactRow[]): { kind: "email" | "phone"; value: string }[] {
  const seen = new Map<string, { kind: "email" | "phone"; value: string }>();
  for (const row of rows) {
    const data: { kind: "email" | "phone"; value: string }[] = [];
    if (row.email) data.push({ kind: "email", value: row.email });
    if (row.phone) data.push({ kind: "phone", value: `+${(row.phoneCc ?? "57").replace(/^\+/, "")}${row.phone}` });
    if (row.mobile) data.push({ kind: "phone", value: `+${(row.mobileCc ?? "57").replace(/^\+/, "")}${row.mobile}` });
    for (const datum of data) seen.set(`${datum.kind}:${datum.value}`, datum);
  }
  return [...seen.values()];
}

/** What `kernel.verify.status` knows about the contacts' data; a caller who may not ask gets none. */
async function verifications(caller: Caller, partyId: string, rows: readonly ContactRow[]): Promise<LoadedRecord["verifications"]> {
  const found: LoadedRecord["verifications"] = {};
  for (const { kind, value } of verifiable(rows)) {
    try {
      const status = (await runProcess(processDeps(), caller, "kernel.verify.status", { kind, value, entity: "core.party", recordId: partyId })) as { status: "queued" | "verified" | "failed" } | null;
      if (status) found[`${kind}:${value}`] = status.status;
    } catch (error) {
      if (error instanceof ProcessError && ["forbidden", "not_entitled", "invalid_input"].includes(error.code)) continue;
      throw error;
    }
  }
  return found;
}

/** A side panel the caller may not read (no permission) is empty, not a failure of the page. */
async function orEmpty<T>(read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) return [];
    throw error;
  }
}

/** A list the caller may not read is null, which is not an empty list. */
async function orNull<T>(read: Promise<T[]>): Promise<T[] | null> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) return null;
    throw error;
  }
}

/** Rows of another entity's grid as the caller sees them; none when the caller may not read that grid. */
export async function gridRows(caller: Caller, entityId: string, state: GridStateInput) {
  const deps = processDeps();
  const entity = gridEntity(deps.registry, entityId);
  if (!entity || (await gridDenial(deps, caller.claims, entity))) return { rows: [], total: 0 };
  return runGridQuery(deps.sql, caller.claims, entity, GridState.parse(state));
}

/**
 * How the references among `values` (by field name) read to the caller: the referenced record's display field, by the
 * referring field's name. One select per target entity, as the caller (`addRefLabels`: the target's grid gate, RLS, the
 * party scope and the masks apply); a reference the caller may not read gets no name.
 */
export async function refLabelsOf(caller: Caller, entity: EntityDef, values: Record<string, unknown>): Promise<Record<string, string>> {
  const deps = processDeps();
  const row: Record<string, unknown> = { ...values };
  await withClaims(deps.sql, caller.claims, (tx) => addRefLabels(tx, deps.registry, entity, [row]));
  const labels: Record<string, string> = {};
  for (const field of entity.fields) {
    const label = field.type === "ref" ? row[refLabelKey(field.name)] : undefined;
    if (typeof label === "string") labels[field.name] = label;
  }
  return labels;
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
  const product = gridEntity(deps.registry, "core.product")!;
  const supplierId = typeof record?.supplier_id === "string" ? record.supplier_id : null;
  const [categories, partyAccess, labels, linkable] = await Promise.all([
    gridRows(caller, "core.product_category", { filters: [], sort: [{ field: "name", dir: "asc" }], page: 1, pageSize: 500, columns: ["name", "iva_rate", "inc_rate", "other_taxes", "default_uom", "status"] }),
    gridPageAccess(deps.sql, caller.claims, party),
    supplierId ? refLabelsOf(caller, product, { supplier_id: supplierId }) : ({} as Record<string, string>),
    linkableEntities(deps, caller.claims, [party.id]),
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
      label: labels.supplier_id ?? null,
      entityLabel: t(party.label),
      // The chosen supplier links to its page when the caller may open parties (rule 21).
      linkable: linkable.has(party.id),
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
  const access = await gridPageAccess(deps.sql, caller.claims, registered);
  const [defs, partyContacts, runnable, required, files] = await Promise.all([
    record ? orEmpty(customFields(caller, entity.id)) : Promise.resolve([]),
    record && entity.id === "core.party" ? orEmpty(contacts(caller, record.id)) : Promise.resolve([]),
    runnableProcesses(deps.sql, deps.registry, caller.claims, [saveProcess, entity.create, ...TAB_PROCESSES]),
    record ? requiredTagsFor(deps.sql, caller.claims, entity.id, factsOf(entity.id, record, access.modes)) : Promise.resolve([]),
    record ? orNull(attachments(caller, entity.id, record.id)) : Promise.resolve([]),
  ]);
  const verified = record && entity.id === "core.party" ? await verifications(caller, record.id, partyContacts as ContactRow[]) : {};
  const canSave = runnable.has(saveProcess);
  if (!record && !canSave) return null;
  // Files and photos change the record, so they also need the right to update it.
  const mayUpdate = runnable.has(entity.update);
  const may = (process: string) => mayUpdate && runnable.has(process);
  const can: RecordAbilities = {
    contactCreate: runnable.has("core.contact.create"),
    contactUpdate: runnable.has("core.contact.update"),
    contactDelete: runnable.has("core.contact.delete"),
    verify: runnable.has("kernel.verify.request"),
    // The `extra` column masked for the caller's role: the tab shows what it may and does not write over it.
    extra: mayUpdate && (access.modes.extra ?? "visible") === "visible",
    attach: may("kernel.attachment.add"),
    removeFile: may("kernel.attachment.remove"),
    reorder: may("kernel.attachment.reorder"),
    suggest: may("kernel.ai.image_suggest"),
    duplicate: record !== null && runnable.has(entity.create),
  };
  const contributed = record ? await loadContributedTabs(caller, entity.id, record.id, gridRows) : [];
  return { entity, caller, record, defs, contacts: partyContacts, modes: access.modes, canSave, can, requiredTags: required, attachments: files, verifications: verified, contributed, form: await formData(caller, entity, record) };
}

/** The processes the record's tabs run besides the save: asked in one round trip. */
const TAB_PROCESSES = [
  "core.party.update",
  "core.product.update",
  "core.category.update",
  "core.contact.create",
  "core.contact.update",
  "core.contact.delete",
  "kernel.verify.request",
  "kernel.attachment.add",
  "kernel.attachment.remove",
  "kernel.attachment.reorder",
  "kernel.ai.image_suggest",
];

/**
 * What the required-file conditions read from the record (`co`, `co-juridica`, `proveedor`, `cliente`): a party's
 * country, person type and kinds; none for the entities without them. A fact the caller's role cannot see is left
 * out, which keeps the requirement on the list (it is never waived for want of information).
 */
function factsOf(entityId: string, record: NonNullable<LoadedRecord["record"]>, modes: Record<string, FieldMode>): ConditionFacts {
  if (entityId !== "core.party") return { countryCode: null, personType: null, kind: null };
  const seen = <T>(field: string, value: unknown): T | undefined => ((modes[field] ?? "visible") === "visible" ? (value as T) : undefined);
  return {
    countryCode: seen<string | null>("country_code", record.country_code),
    personType: seen<string | null>("person_type", record.person_type),
    kind: seen<string[] | null>("kind", record.kind),
  };
}
