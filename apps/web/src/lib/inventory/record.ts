import "server-only";
import { getTranslations } from "next-intl/server";
import { addRefLabels, gridPageAccess, refLabelKey, runnableProcesses, withClaims, type Caller } from "@erp/kernel";
import { formatDay, formatDayTime, formatMoney, type CodeOption, type LocationOption, type LookupSource, type StockFormKind } from "@erp/ui";
import { gridTab, type GridTab } from "@/lib/accounting/record-tabs";
import { gridEntity } from "@/lib/grid/access";
import { buildColumns } from "@/lib/grid/columns";
import { linkableEntities } from "@/lib/grid/links";
import { presentationOf } from "@/lib/grid/presentation";
import { processDeps } from "@/lib/server/runtime";

// What the Datos tab of an inventory or costing record needs besides the record (plan 2B Task 10), read as the caller: the bodegas and
// ubicaciones the selects offer (masked views, the transit bodega left out: only a traslado's own legs move stock there), the fields of
// the product, receipt and supplier boxes, and for a stored document its facts, its lines in the universal grid (rule 20) and the steps
// the caller may run on it (Despachar, Recibir, Registrar conteo, Aplicar conteo). Every read goes through the masked views or the grid.
// Task 28.5: the lote, serial and seguimiento forms get the tracked products, a serial the lots of its product, and the names of their
// references; an open conteo gets what «Agregar encontrado» offers (the tracking of the products it may find and their lots).

/** The inventory and costing entities with a full record page, and their form. */
export const STOCK_FORMS: Readonly<Record<string, StockFormKind>> = {
  "inventory.warehouse": "warehouse",
  "inventory.location": "location",
  "inventory.movement": "movement",
  "inventory.transfer": "transfer",
  "inventory.count": "count",
  "costing.landed_cost": "landed_cost",
  // Task 28.5: the lote and the serial (maestros) and the seguimiento por producto (parametro, keyed by its product).
  "inventory.lot": "lot",
  "inventory.serial": "serial",
  "inventory.product_tracking": "tracking",
};

/** The steps a stored document's screen runs besides the bar's lifecycle buttons, by entity and step name (the action's allowlist). */
export const STOCK_STEP_PROCESSES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "inventory.transfer": { ship: "inventory.transfer.ship", receive: "inventory.transfer.receive" },
  "inventory.count": { record: "inventory.count.record", apply: "inventory.count.apply" },
};
const STOCK_STEPS = ["inventory.transfer.ship", "inventory.transfer.receive", "inventory.count.record", "inventory.count.apply"] as const;
export type StockStep = (typeof STOCK_STEPS)[number];

/** A fact of a stored document's header: its label, its value as text and, for a reference, the record it links to (rule 21). */
export interface StockFact {
  label: string;
  value: string;
  link?: { entity: string; id: string };
  mono?: boolean;
  testId?: string;
}

/** A line of a conteo as its sheet shows it. */
export interface CountSheetLine {
  id: string;
  lineNo: number;
  product: string;
  location: string;
  /** The lot's code or the serial number the line counts (Task 28.2); empty for an untracked product. */
  lotSerial: string;
  /** The lot or serial the line counts, when the caller may open it (rule 21, Task 28.5). */
  lotSerialLink?: { entity: "inventory.lot" | "inventory.serial"; id: string };
  systemQty: number | null;
  countedQty: number | null;
  difference: number | null;
}

export interface StockView {
  facts: StockFact[];
  /** The lines in the universal grid; null when the caller may not read them. */
  linesGrid: GridTab | null;
  /** traslado: requested · in_transit · received; conteo: open · applied. */
  stage: string | null;
  stageLabel: string | null;
  /** The steps the caller may run now (rights ∩ stage ∩ status). */
  steps: StockStep[];
  /** conteo: its sheet; the ajuste it posted once applied. */
  countLines: CountSheetLine[];
  adjustment: { id: string; number: string } | null;
  /**
   * An open conteo the caller may record (Task 28.5): what «Agregar encontrado» offers. The tracking of the products the count may find (a
   * product absent is untracked: the count lists it when created) and the lots of each lot product, as `code · vence`.
   */
  found: { warehouseId: string; tracking: Record<string, "lot" | "serial">; lots: Record<string, CodeOption[]> } | null;
}

export interface StockFormData {
  kind: "stock";
  stock: StockFormKind;
  today: string;
  warehouses: CodeOption[];
  locations: LocationOption[];
  product: LookupSource;
  receipt: LookupSource | null;
  party: LookupSource | null;
  /** A landed cost (Task 45): the cost centers of its cost of sales part; null when the caller may not read them (or accounting is off). */
  costCenter: LookupSource | null;
  /** How inventory tracks each tracked product, by id (Task 28.2): the lines of a new document ask for the lot or the serials. */
  tracking: Record<string, "lot" | "serial">;
  /** A stored movimiento, traslado, conteo or costo en destino; null for a new one and for the maestros. */
  view: StockView | null;
  /** A lote, serial or seguimiento (Task 28.5): its references as the caller reads them, by field (`product_id`, `lot_id`). */
  labels: Record<string, string>;
  /** A new lote: the products tracked by lot; a new serial: those tracked by serial (`SKU · descripción`). Empty for the other forms. */
  trackedProducts: CodeOption[];
  /** A new serial: the lots of each of those products, by product id. */
  lots: Record<string, CodeOption[]>;
}

type Row = Record<string, unknown> & { id: string };

/** The forms of Task 28.5 whose references the form names (product, lot). */
const TRACKED_FORMS: ReadonlySet<StockFormKind> = new Set(["lot", "serial", "tracking"]);

const LINES: Record<string, { entity: string; parent: string }> = {
  "inventory.movement": { entity: "inventory.movement_line", parent: "movement_id" },
  "inventory.transfer": { entity: "inventory.transfer_line", parent: "transfer_id" },
  "inventory.count": { entity: "inventory.count_line", parent: "count_id" },
  "costing.landed_cost": { entity: "costing.landed_cost_line", parent: "landed_cost_id" },
};

/** The fields of an entity's lookup box as the caller sees them; null when the caller may not read the entity. */
async function lookupSource(caller: Caller, entityId: string): Promise<LookupSource | null> {
  const deps = processDeps();
  const entity = gridEntity(deps.registry, entityId);
  if (!entity) return null;
  const [access, t, linkable] = await Promise.all([gridPageAccess(deps.sql, caller.claims, entity), getTranslations(), linkableEntities(deps, caller.claims, [entityId])]);
  return { fields: buildColumns(entity, access, presentationOf(entity.id), (key) => t(key)), entityLabel: t(entity.label), linkable: linkable.has(entityId) };
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

/** The Datos tab's data of an inventory or costing record. */
export async function loadStockForm(caller: Caller, entityId: string, record: Row | null): Promise<StockFormData> {
  const deps = processDeps();
  const stock = STOCK_FORMS[entityId]!;
  const t = await getTranslations();
  const [lists, product, receipt, party, costCenter] = await Promise.all([
    withClaims(deps.sql, caller.claims, async (tx) => {
      const [today] = await tx<{ today: string }[]>`select (now() at time zone timezone)::date::text as today from kernel.companies where id = ${caller.claims.active_company_id}`;
      const warehouses = await tx<{ id: string; code: string | null; name: string | null }[]>`
        select w.id, w.code, w.name from inventory.v_warehouses w
        where coalesce(w.is_active, true) and w.status in ('saved', 'approved')
          and not exists (select 1 from inventory.v_locations l where l.warehouse_id = w.id and l.kind = 'transit')
        order by w.code`;
      const locations = await tx<{ id: string; warehouse_id: string; code: string | null; name: string | null }[]>`
        select id, warehouse_id, code, name from inventory.v_locations where coalesce(is_active, true) and kind = 'storage' order by code`;
      // The tracked products (Task 28.2), as the caller may read the parametro; a product without a row is untracked. Their names (Task 28.5)
      // through core's masked view, as the lot-trace report reads them.
      const tracked = await tx<{ product_id: string; tracking: "lot" | "serial"; sku: string | null; description: string | null }[]>`
        select t.product_id, t.tracking, p.sku, p.description from inventory.v_product_tracking t left join core.v_products p on p.id = t.product_id
        where t.tracking in ('lot', 'serial') order by p.sku nulls last`;
      // The lots a serial form or a conteo's found rows offer (Task 28.5): of the lot-tracked products for a conteo, of the serial ones for a serial.
      const lotsOf = stock === "serial" ? "serial" : stock === "count" && record ? "lot" : null;
      const lots = !lotsOf ? [] : await tx<{ id: string; product_id: string; code: string; expires_on: string | null }[]>`
        select l.id, l.product_id, l.code, l.expires_on::text from inventory.v_lots l join inventory.v_product_tracking t on t.product_id = l.product_id and t.tracking = ${lotsOf}
        order by l.expires_on nulls last, l.code limit 2000`;
      const labels: Record<string, string> = {};
      if (record && TRACKED_FORMS.has(stock)) {
        const row: Record<string, unknown> = { ...record };
        await addRefLabels(tx, deps.registry, deps.registry.entity(entityId), [row]);
        for (const field of ["product_id", "lot_id"]) if (typeof row[refLabelKey(field)] === "string") labels[field] = String(row[refLabelKey(field)]);
      }
      return { today: today?.today ?? new Date().toISOString().slice(0, 10), warehouses, locations, tracked, lots, labels };
    }),
    lookupSource(caller, "core.product"),
    stock === "landed_cost" ? lookupSource(caller, "inventory.movement") : Promise.resolve(null),
    stock === "landed_cost" ? lookupSource(caller, "core.party") : Promise.resolve(null),
    stock === "landed_cost" ? lookupSource(caller, "accounting.cost_center") : Promise.resolve(null),
  ]);
  const tracking = Object.fromEntries(lists.tracked.map((r) => [r.product_id, r.tracking]));
  const lotOptions: Record<string, CodeOption[]> = {};
  for (const l of lists.lots) (lotOptions[l.product_id] ??= []).push({ code: l.id, name: [l.code, l.expires_on?.replaceAll("-", "/")].filter(Boolean).join(" · ") });
  const view = record && LINES[entityId] ? await stockView(caller, entityId, record, { tracking, lots: lotOptions }) : null;
  const productName = (r: { product_id: string; sku: string | null; description: string | null }) => [r.sku, r.description].filter(Boolean).join(" · ") || r.product_id;
  return {
    kind: "stock",
    stock,
    today: lists.today,
    warehouses: lists.warehouses.map((w) => ({ code: w.id, name: [w.code, w.name].filter(Boolean).join(" · ") })),
    locations: lists.locations.map((l) => ({ code: l.id, warehouseId: l.warehouse_id, name: [l.code, l.name].filter(Boolean).join(" · ") })),
    product: product ?? { fields: [], entityLabel: t("entity.core.product") },
    tracking,
    receipt,
    party,
    costCenter,
    view,
    labels: lists.labels,
    trackedProducts: stock === "lot" || stock === "serial" ? lists.tracked.filter((r) => r.tracking === stock).map((r) => ({ code: r.product_id, name: productName(r) })) : [],
    lots: stock === "serial" ? lotOptions : {},
  };
}

/** The facts, lines and steps of a stored document. */
async function stockView(caller: Caller, entityId: string, record: Row, findable: { tracking: Record<string, "lot" | "serial">; lots: Record<string, CodeOption[]> }): Promise<StockView> {
  const deps = processDeps();
  const t = await getTranslations();
  const entity = deps.registry.entity(entityId);
  const lines = LINES[entityId]!;
  // The references of the header as the caller may read them (the masks and the grid gates of their entities apply).
  const header: Record<string, unknown> = { ...record };
  const sheet = Array.isArray(record.lines) ? (record.lines as Record<string, unknown>[]).map((l) => ({ ...l })) : [];
  await withClaims(deps.sql, caller.claims, async (tx) => {
    await addRefLabels(tx, deps.registry, entity, [header]);
    if (entityId === "inventory.count") await addRefLabels(tx, deps.registry, deps.registry.entity(lines.entity), sheet);
  });
  const [linesGrid, runnable, linkable, zone] = await Promise.all([
    gridTab(caller, lines.entity, [{ field: lines.parent, op: "eq", value: record.id }]),
    runnableProcesses(deps.sql, deps.registry, caller.claims, [...STOCK_STEPS]),
    linkableEntities(deps, caller.claims, ["inventory.warehouse", "inventory.movement", "core.party", "inventory.lot", "inventory.serial"]),
    withClaims(deps.sql, caller.claims, (tx) => tx<{ timezone: string }[]>`select timezone from kernel.companies where id = ${caller.claims.active_company_id}`),
  ]);
  const timeZone = zone[0]?.timezone;
  // Lots and serials (Task 28.2): their columns show only when some line of the document names one (an untracked document reads as before).
  const tracked = sheet.some((l) => l.lot_id || l.serial_id);
  if (linesGrid && !tracked) linesGrid.columns = linesGrid.columns.filter((c) => c.field !== "lot_id" && c.field !== "serial_id");
  const label = (field: string) => {
    const def = entity.fields.find((f) => f.name === field);
    return def && t.has(def.label) ? t(def.label) : field;
  };
  const value = (field: string): string => {
    const def = entity.fields.find((f) => f.name === field);
    const raw = record[field];
    if (raw === null || raw === undefined || raw === "") return "—";
    if (def?.type === "ref") return String(header[refLabelKey(field)] ?? raw);
    if (def?.valuesKey && typeof raw === "string" && t.has(`${def.valuesKey}.${raw}`)) return t(`${def.valuesKey}.${raw}`);
    // A calendar date reads AAAA/MM/DD (owner 2026-10-31): the driver gives it as UTC midnight.
    if (def?.type === "date") return raw instanceof Date ? formatDay(raw, "UTC") : String(raw).slice(0, 10).replaceAll("-", "/");
    if (def?.type === "datetime") return formatDayTime(raw instanceof Date ? raw.toISOString() : String(raw), timeZone);
    if (def?.type === "money") return formatMoney(Number(raw));
    return String(raw);
  };
  const ref = (field: string, target: string): StockFact => {
    const raw = record[field];
    return { label: label(field), value: value(field), ...(typeof raw === "string" && linkable.has(target) ? { link: { entity: target, id: raw } } : {}) };
  };
  const plain = (field: string, extra: Partial<StockFact> = {}): StockFact => ({ label: label(field), value: value(field), ...extra });

  const facts: StockFact[] = [];
  let stage: string | null = null;
  const steps: StockStep[] = [];
  const live = record.status !== "voided";
  if (entityId === "inventory.movement") {
    facts.push(plain("kind"), plain("date"), ref("warehouse_id", "inventory.warehouse"), plain("reference"), plain("description"));
    if (typeof record.source_entity === "string" && record.source_entity) facts.push({ label: label("source_entity"), value: t.has(`entity.${record.source_entity}`) ? t(`entity.${record.source_entity}`) : record.source_entity, ...(typeof record.source_id === "string" && STOCK_FORMS[record.source_entity] ? { link: { entity: record.source_entity, id: record.source_id } } : {}) });
  } else if (entityId === "inventory.transfer") {
    stage = String(record.stage ?? "");
    facts.push(plain("date"), ref("from_warehouse_id", "inventory.warehouse"), ref("to_warehouse_id", "inventory.warehouse"), plain("reference"), plain("description"), plain("shipped_at"), plain("received_at"));
    if (live && stage === "requested" && runnable.has("inventory.transfer.ship")) steps.push("inventory.transfer.ship");
    if (live && stage === "in_transit" && runnable.has("inventory.transfer.receive")) steps.push("inventory.transfer.receive");
  } else if (entityId === "inventory.count") {
    stage = String(record.stage ?? "");
    facts.push(plain("date"), ref("warehouse_id", "inventory.warehouse"), plain("description"), plain("applied_at"));
    if (live && stage === "open" && runnable.has("inventory.count.record")) steps.push("inventory.count.record");
    if (live && stage === "open" && runnable.has("inventory.count.apply")) steps.push("inventory.count.apply");
  } else {
    facts.push(plain("date"), ref("movement_id", "inventory.movement"), plain("amount"), plain("basis"), plain("offset_role"), ref("party_id", "core.party"), plain("reference"), plain("description"));
    // Task 45 (R45-7): the share of units already sold went to cost of sales; the lines show the split, the header says how much in all.
    const cogs = sheet.reduce((sum, l) => sum + Math.round(Number(l.amount_cogs ?? 0) * 100), 0);
    if (cogs !== 0) facts.push({ label: t("costing.form.cogs_note"), value: formatMoney(cogs / 100) });
  }
  const stageDef = entity.fields.find((f) => f.name === "stage");
  const adjustmentId = typeof record.adjustment_id === "string" ? record.adjustment_id : null;
  return {
    // An empty fact (no reference, not shipped yet) is left out.
    facts: facts.filter((f) => f.value !== "—"),
    linesGrid,
    stage,
    stageLabel: stage && stageDef?.valuesKey && t.has(`${stageDef.valuesKey}.${stage}`) ? t(`${stageDef.valuesKey}.${stage}`) : stage,
    steps,
    countLines:
      entityId === "inventory.count"
        ? sheet.map((l) => ({
            id: String(l.id),
            lineNo: Number(l.line_no),
            product: String(l[refLabelKey("product_id")] ?? l.product_id ?? ""),
            location: l.location_id ? String(l[refLabelKey("location_id")] ?? l.location_id) : "",
            lotSerial: l.serial_id ? String(l[refLabelKey("serial_id")] ?? l.serial_id) : l.lot_id ? String(l[refLabelKey("lot_id")] ?? l.lot_id) : "",
            ...(lotSerialLink(l, linkable) ? { lotSerialLink: lotSerialLink(l, linkable)! } : {}),
            systemQty: num(l.system_qty),
            countedQty: num(l.counted_qty),
            difference: num(l.difference),
          }))
        : [],
    adjustment: adjustmentId ? { id: adjustmentId, number: String(header[refLabelKey("adjustment_id")] ?? adjustmentId) } : null,
    found: entityId === "inventory.count" && steps.includes("inventory.count.record") ? { warehouseId: String(record.warehouse_id ?? ""), ...findable } : null,
  };
}

/** The record a count line's lot or serial links to, when the caller may open it (rule 21). */
function lotSerialLink(line: Record<string, unknown>, linkable: ReadonlySet<string>): CountSheetLine["lotSerialLink"] | null {
  if (typeof line.serial_id === "string" && linkable.has("inventory.serial")) return { entity: "inventory.serial", id: line.serial_id };
  if (typeof line.lot_id === "string" && !line.serial_id && linkable.has("inventory.lot")) return { entity: "inventory.lot", id: line.lot_id };
  return null;
}
