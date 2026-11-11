import { getLocale, getTranslations } from "next-intl/server";
import { loadLifecycle, type LoadedLifecycle } from "./lifecycle-load";
import {
  addRefLabels,
  GridState,
  labelText,
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
import type { CategoryOption, GridColumn, MasterKind, PartyTables, ProductTables } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { gridDenial, gridEntity } from "@/lib/grid/access";
import { buildColumns } from "@/lib/grid/columns";
import { linkableEntities } from "@/lib/grid/links";
import { presentationOf } from "@/lib/grid/presentation";
import { processDeps } from "@/lib/server/runtime";
import { loadEntryForm, type EntryFormData } from "@/lib/accounting/entry-load";
import { gridTab, loadAccountingTabs, loadMasterOptions, type AccountingTabs, type GridTab, type MasterOptions, type TemplateLineView } from "@/lib/accounting/record-tabs";
import { loadContributedTabs, type LoadedContribution } from "./contributed-load";
import { NEW_RECORD_ID, recordEntity, type RecordEntity } from "./entities";
import { partyTables, productTables } from "./tables";
import { loadStockForm, STOCK_FORMS, type StockFormData } from "@/lib/inventory/record";
import { loadSalesForm, SALES_FORMS, type SalesFormData } from "@/lib/sales/record";
import { INVOICING_FORMS, loadInvoicingForm, type InvoicingFormData } from "@/lib/invoicing/record";
import { loadPaymentsForm, PAYMENTS_FORMS, type PaymentsFormData } from "@/lib/payments/record";
import { loadWarehouseForm, WAREHOUSE_FORMS, type WarehouseFormData } from "@/lib/warehouse/record";

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
  | { kind: "category"; tables: ProductTables; productCount: number }
  | ({ kind: "entry"; linesGrid: GridTab | null } & EntryFormData)
  // The accounting masters (Task 28): Cuenta, the four analytic nodes, Fuente, Plantilla, Período and Regla contable share one form.
  | { kind: "master"; master: MasterKind; options: MasterOptions; templateLines: TemplateLineView[] | null; rule: { isDefault: boolean; isModified: boolean; stale: boolean; staleDays: number } | null }
  // The inventory and costing records (plan 2B Task 10): bodega, ubicación, movimiento, traslado, conteo, costo en destino.
  | StockFormData
  // The CRM and sales records (plan 2B Task 14b): prospecto, embudo, oportunidad, actividad, cotización, pedido, entrega, devolución.
  | SalesFormData
  // The invoice and the note (plan 2B Task 20).
  | InvoicingFormData
  // The medio de pago, the caja and the recibo de caja (plan 2B Task 24b).
  | PaymentsFormData
  // The alistamiento and the empaque (plan 2B.2 Task 29.4).
  | WarehouseFormData;

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
  /** The record's title as text (`labelText` of its title field); the page formats it with `formatLabel`. */
  title: string | null;
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
  /** The tabs of an accounting master besides Datos (Saldos, Seguridad, Cierre, Líneas…); null for any other record. */
  accounting: AccountingTabs | null;
  form: FormData;
  /** A maestro or documento: the action bar's facts, Versiones and Acceso (Task 15); null for any other record. */
  lifecycle: LoadedLifecycle | null;
}

/** The accounting masters and the form kind each opens (Task 28). */
const MASTER_KINDS: Readonly<Record<string, MasterKind>> = {
  "accounting.account": "account",
  "accounting.cost_center": "dimension",
  "accounting.open_auxiliary": "dimension",
  "accounting.item": "dimension",
  "accounting.business_unit": "dimension",
  "accounting.journal": "journal",
  "accounting.entry_template": "template",
  "accounting.period": "period",
  "accounting.posting_rule": "rule",
};

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

/** The «Sin coincidencias en N días» flag of a rule (Task 50.6): from `posting_rule.consult`; a caller who may not consult sees no flag. */
async function ruleStale(caller: Caller, id: string): Promise<{ stale: boolean; staleDays: number }> {
  try {
    const [rule, settings] = await Promise.all([
      runProcess(processDeps(), caller, "accounting.posting_rule.consult", { id }) as Promise<{ stale?: boolean }>,
      runProcess(processDeps(), caller, "accounting.settings.consult", {}) as Promise<{ ruleStaleDays?: number }>,
    ]);
    return { stale: rule.stale === true, staleDays: settings.ruleStaleDays ?? 30 };
  } catch (error) {
    if (error instanceof ProcessError && ["forbidden", "not_entitled", "not_found", "step_up_required"].includes(error.code)) return { stale: false, staleDays: 30 };
    throw error;
  }
}

async function formData(caller: Caller, entity: RecordEntity, record: LoadedRecord["record"], accounting: AccountingTabs | null, templateId: string | null = null): Promise<FormData> {
  const master = MASTER_KINDS[entity.id];
  if (master) {
    return {
      kind: "master",
      master,
      options: await loadMasterOptions(caller, entity.id, record?.id ?? null),
      templateLines: accounting?.kind === "template" ? accounting.lines : null,
      rule: master === "rule" && record ? { isDefault: record.is_default === true, isModified: record.is_modified === true, ...(await ruleStale(caller, record.id)) } : null,
    };
  }
  if (STOCK_FORMS[entity.id]) return loadStockForm(caller, entity.id, record);
  if (SALES_FORMS[entity.id]) return loadSalesForm(caller, entity.id, record);
  if (INVOICING_FORMS[entity.id]) return loadInvoicingForm(caller, entity.id, record);
  if (PAYMENTS_FORMS[entity.id]) return loadPaymentsForm(caller, entity.id, record);
  if (WAREHOUSE_FORMS[entity.id]) return loadWarehouseForm(caller, entity.id, record);
  const locale = await getLocale();
  if (entity.id === "core.party") return { kind: "party", tables: partyTables(locale) };
  if (entity.id === "accounting.entry") {
    // Rule 20: a stored comprobante's lines read in the universal grid too (sort, per-column filter, advanced filter, pages, exports).
    const [entry, linesGrid] = await Promise.all([loadEntryForm(caller, record, record ? null : templateId), record ? gridTab(caller, "accounting.entry_line", [{ field: "entry_id", op: "eq", value: record.id }]) : null]);
    return { kind: "entry", ...entry, linesGrid };
  }
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
    gridRows(caller, "core.product_category", { filters: [], sort: [{ field: "name", dir: "asc" }], page: 1, pageSize: 500, columns: ["name", "iva_rate", "inc_rate", "other_taxes", "default_uom", "is_active"] }),
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
      active: c.is_active !== false,
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
 * The input of the entity's consult for the record `id`: `{ id }`, or for a parametro keyed by another field (Task 28.5) that key, read
 * from the entity's masked view as the caller (RLS and the masks apply; a row the caller cannot see answers not_found like the consult).
 */
async function consultInput(caller: Caller, entity: RecordEntity, id: string): Promise<Record<string, unknown>> {
  const keyed = entity.keyedBy;
  if (!keyed) return { id };
  const rows = await withClaims(processDeps().sql, caller.claims, (tx) => tx<Record<string, unknown>[]>`select ${tx(keyed.column)} as key from ${tx(keyed.view)} where id = ${id}`);
  const key = rows[0]?.key;
  if (typeof key !== "string") throw new ProcessError("not_found", `${entity.id} ${id} not found`);
  return { [keyed.input]: key };
}

/**
 * The record `/r/<entity>/<id>` shows, or null when the entity has no full page, the id is neither a UUID nor `new`,
 * the record does not exist for the caller (a hidden record looks like a missing one), or `new` is asked by a caller
 * who may not create. Throws `Unauthenticated` without a complete session; the page turns that into a redirect.
 */
export async function loadRecord(entityId: string, id: string, options: { templateId?: string | null } = {}): Promise<LoadedRecord | null> {
  const entity = recordEntity(entityId);
  if (!entity || (id !== NEW_RECORD_ID && !UUID.test(id))) return null;
  const caller = await requireCaller();
  const deps = processDeps();
  const registered = gridEntity(deps.registry, entity.id);
  if (!registered) return null;

  let record: LoadedRecord["record"] = null;
  if (id !== NEW_RECORD_ID) {
    try {
      record = (await runProcess(deps, caller, entity.consult, await consultInput(caller, entity, id))) as LoadedRecord["record"];
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
    runnableProcesses(deps.sql, deps.registry, caller.claims, [saveProcess, entity.create, entity.update, ...TAB_PROCESSES].filter((p) => p !== "")),
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
    // A parametro keyed by another field (Task 28.5) saves no extra data through its one process.
    extra: mayUpdate && !entity.keyedBy && (access.modes.extra ?? "visible") === "visible",
    attach: may("kernel.attachment.add"),
    removeFile: may("kernel.attachment.remove"),
    reorder: may("kernel.attachment.reorder"),
    suggest: may("kernel.ai.image_suggest"),
    duplicate: record !== null && !entity.keyedBy && runnable.has(entity.create),
  };
  const contributed = record ? await loadContributedTabs(caller, entity.id, record.id, gridRows) : [];
  const accounting = record && MASTER_KINDS[entity.id] ? await loadAccountingTabs(caller, entity.id, record) : null;
  const titleValue = record?.[entity.titleField];
  const titleDef = registered.fields.find((f) => f.name === entity.titleField);
  // A record named by a reference (a seguimiento by its product, Task 28.5) reads as that record's name, as the caller may read it.
  const titleRef = record && titleDef?.type === "ref" && typeof titleValue === "string" ? (await refLabelsOf(caller, registered, { [entity.titleField]: titleValue }))[entity.titleField] : undefined;
  const title = titleValue === null || titleValue === undefined || titleValue === "" ? null : (titleRef ?? labelText(titleValue, titleDef));
  const t = await getTranslations();
  const translate = (key: string) => (typeof t.has !== "function" || t.has(key) ? t(key) : key);
  const lifecycle = await loadLifecycle(caller, registered, record, access.modes, translate, canSave);
  if (lifecycle) lifecycle.tools.new = entity.create !== "" && runnable.has(entity.create);
  return { entity, caller, record, title, defs, contacts: partyContacts, modes: access.modes, canSave, can, requiredTags: required, attachments: files, verifications: verified, contributed, accounting, form: await formData(caller, entity, record, accounting, UUID.test(options.templateId ?? "") ? (options.templateId as string) : null), lifecycle };
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
