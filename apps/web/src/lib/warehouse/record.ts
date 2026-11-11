import "server-only";
import { getTranslations } from "next-intl/server";
import { addRefLabels, refLabelKey, runnableProcesses, withClaims, type Caller } from "@erp/kernel";
import { formatDayTime } from "@erp/ui";
import { linkableEntities } from "@/lib/grid/links";
import { processDeps } from "@/lib/server/runtime";

// What the Datos tab of an alistamiento or an empaque needs besides the record (plan 2B.2 Task 29.4, PG §4.3, rules 14, 21), read as the
// caller through the masked views of warehouse and the published views of sales, inventory and core (rule 3): the header's facts (the
// pedido, the customer, the bodega, inventory's answer and the empaque made from it, each a link the caller may open; the entrega made from
// it is in «Relacionados», the document link pick_to_delivery of Task 29.2),
// the lines (an alistamiento's with what each bucket of its product holds in the bodega, so the picker chooses where each line was taken
// from; an empaque's packages) and the steps the caller may run now. An alistamiento and an empaque never change but through their steps.

type Row = Record<string, unknown> & { id: string };

/** The warehouse entities with a full record page, and their screen. */
export const WAREHOUSE_FORMS: Readonly<Record<string, "pick" | "pack">> = { "warehouse.pick": "pick", "warehouse.pack": "pack" };

/** The steps a stored record's screen runs, by entity and step name (the action's allowlist; Anular is the bar's). */
export const WAREHOUSE_STEPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "warehouse.pick": { start: "warehouse.pick.start", update: "warehouse.pick.update", confirm: "warehouse.pick.confirm", pack: "warehouse.pack.create" },
  "warehouse.pack": { update: "warehouse.pack.update", close: "warehouse.pack.close" },
};

export interface WarehouseFact {
  label: string;
  value: string;
  link?: { entity: string; id: string };
  mono?: boolean;
  testId?: string;
}

/** Where a line may be taken from: one bucket of its product in the bodega (ubicación, lot, serial) and what it holds. */
export interface PickSource {
  key: string;
  locationId: string | null;
  lotId: string | null;
  serialId: string | null;
  label: string;
}

export interface PickLineView {
  id: string;
  lineNo: number;
  product: string;
  productId: string;
  tracking: "none" | "lot" | "serial";
  /** The bucket the line names now (its key in `sources`), or empty when it names none. */
  sourceKey: string;
  /** The ubicación, lot and serial the line names, in words. */
  source: string;
  qtyRequested: number;
  qtyPicked: number | null;
  shortQty: number | null;
  sources: PickSource[];
}

export interface PackageView {
  id: string;
  packageNo: number;
  weightKg: number | null;
  dimensions: string | null;
  contents: string | null;
  /** What it holds (the process reads it back on Guardar). */
  items: { pickLineId: string; qty: number }[];
}

export interface WarehouseView {
  kind: "pick" | "pack";
  facts: WarehouseFact[];
  stage: string | null;
  stageLabel: string | null;
  /** The steps the caller may run now (rights ∩ stage ∩ status), as process ids. */
  steps: string[];
  pickLines: PickLineView[];
  packages: PackageView[];
}

export interface WarehouseFormData {
  kind: "warehouse";
  warehouse: "pick" | "pack";
  view: WarehouseView | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const text = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const qty = (n: number) => new Intl.NumberFormat("es-CO", { maximumFractionDigits: 4 }).format(n);
const bucketKey = (locationId: string | null, lotId: string | null, serialId: string | null) => `${locationId ?? ""}|${lotId ?? ""}|${serialId ?? ""}`;

export async function loadWarehouseForm(caller: Caller, entityId: string, record: Row | null): Promise<WarehouseFormData> {
  const kind = WAREHOUSE_FORMS[entityId]!;
  return { kind: "warehouse", warehouse: kind, view: record ? await warehouseView(caller, entityId, record) : null };
}

async function warehouseView(caller: Caller, entityId: string, record: Row): Promise<WarehouseView> {
  const deps = processDeps();
  const t = await getTranslations();
  const entity = deps.registry.entity(entityId);
  const isPick = entityId === "warehouse.pick";
  const header: Record<string, unknown> = { ...record };
  const read = await withClaims(deps.sql, caller.claims, async (tx) => {
    await addRefLabels(tx, deps.registry, entity, [header]);
    const [company] = await tx<{ timezone: string }[]>`select timezone from kernel.companies where id = ${caller.claims.active_company_id}`;
    if (!isPick) {
      const packages = await tx<{ id: string; package_no: number; weight_kg: string | null; dimensions: string | null; contents: string | null; items: { pickLineId: string; qty: number }[] | null }[]>`
        select id, package_no, weight_kg::text, dimensions, contents, items from warehouse.v_pack_packages where pack_id = ${record.id} order by package_no`;
      return { timeZone: company?.timezone, packages, lines: [], buckets: [], tracking: new Map<string, string>(), pack: null };
    }
    const lines = await tx<{
      id: string; line_no: number; product_id: string; product: string | null; qty_requested: string; qty_picked: string | null; short_qty: string | null;
      location_id: string | null; location: string | null; lot_id: string | null; lot: string | null; serial_id: string | null; serial: string | null;
    }[]>`
      select l.id, l.line_no, l.product_id, p.description as product, l.qty_requested::text, l.qty_picked::text, l.short_qty::text,
             l.location_id, coalesce(loc.code, loc.name) as location, l.lot_id, lot.code as lot, l.serial_id, s.serial_no as serial
      from warehouse.v_pick_lines l
      left join core.v_products p on p.id = l.product_id
      left join inventory.v_locations loc on loc.id = l.location_id
      left join inventory.v_lots lot on lot.id = l.lot_id
      left join inventory.v_serials s on s.id = l.serial_id
      where l.pick_id = ${record.id} order by l.line_no`;
    const products = [...new Set(lines.map((l) => l.product_id))];
    const tracking = new Map((await tx<{ product_id: string; tracking: string }[]>`
      select product_id, tracking from inventory.v_product_tracking where product_id = any(${products}::uuid[])`).map((r) => [r.product_id, r.tracking]));
    // What each product's buckets hold in the alistamiento's bodega (storage ubicaciones; the bodega's own stock without ubicación too).
    const buckets = typeof record.warehouse_id === "string"
      ? await tx<{ product_id: string; location_id: string | null; location: string | null; lot_id: string | null; lot: string | null; expires_on: string | null; serial_id: string | null; serial: string | null; on_hand: string }[]>`
          select s.product_id, s.location_id, coalesce(loc.code, loc.name) as location, s.lot_id, lot.code as lot, lot.expires_on::text, s.serial_id, sr.serial_no as serial, s.on_hand::text
          from inventory.v_stock_levels s
          left join inventory.v_locations loc on loc.id = s.location_id
          left join inventory.v_lots lot on lot.id = s.lot_id
          left join inventory.v_serials sr on sr.id = s.serial_id
          where s.warehouse_id = ${record.warehouse_id} and s.product_id = any(${products}::uuid[]) and s.on_hand > 0 and (s.location_id is null or loc.kind = 'storage')
          order by lot.expires_on nulls last, lot.code nulls first, loc.code nulls first, sr.serial_no`
      : [];
    const [pack] = await tx<{ id: string; number: string | null }[]>`select id, number from warehouse.v_packs where pick_id = ${record.id} and status <> 'voided' limit 1`;
    return { timeZone: company?.timezone, packages: [], lines, buckets, tracking, pack: pack ?? null };
  });

  const stepsOf = WAREHOUSE_STEPS[entityId] ?? {};
  const [runnable, linkable] = await Promise.all([
    runnableProcesses(deps.sql, deps.registry, caller.claims, Object.values(stepsOf)),
    linkableEntities(deps, caller.claims, ["sales.order", "core.party", "inventory.warehouse", "warehouse.pick", "warehouse.pack"]),
  ]);
  const stage = typeof record.stage === "string" ? record.stage : null;
  const voided = record.status === "voided";
  const ref = (field: string, target: string, testId?: string): WarehouseFact | null => {
    const id = record[field];
    if (typeof id !== "string") return null;
    const label = header[refLabelKey(field)];
    const value = typeof label === "string" ? label : "—";
    const def = entity.fields.find((f) => f.name === field);
    return { label: def && t.has(def.label) ? t(def.label) : field, value, ...(typeof label === "string" && linkable.has(target) ? { link: { entity: target, id } } : {}), ...(testId ? { testId } : {}) };
  };
  const plain = (field: string, value: string, mono = false): WarehouseFact => {
    const def = entity.fields.find((f) => f.name === field);
    return { label: def && t.has(def.label) ? t(def.label) : field, value: value || "—", ...(mono ? { mono } : {}) };
  };
  const facts: WarehouseFact[] = [];
  const steps: string[] = [];
  const may = (step: string) => runnable.has(stepsOf[step]!);
  if (isPick) {
    for (const f of [ref("order_id", "sales.order", "pick-order"), ref("party_id", "core.party"), ref("warehouse_id", "inventory.warehouse")]) if (f) facts.push(f);
    if (record.allocation_status) {
      facts.push({ ...plain("allocation_status", t(`warehouse.values.allocation_status.${text(record.allocation_status)}`)), testId: "pick-allocation" });
      if (record.allocation_note) facts.push(plain("allocation_note", text(record.allocation_note)));
    }
    if (record.confirmed_at) facts.push(plain("confirmed_at", formatDayTime(text(record.confirmed_at), read.timeZone)));
    if (read.pack) facts.push({ label: t("warehouse.view.pack"), value: read.pack.number ?? "—", mono: true, ...(linkable.has("warehouse.pack") ? { link: { entity: "warehouse.pack", id: read.pack.id } } : {}), testId: "pick-pack" });
    if (!voided && stage !== "confirmed") {
      if (stage === "open" && may("start")) steps.push(stepsOf.start!);
      if (may("update")) steps.push(stepsOf.update!);
      if (may("confirm")) steps.push(stepsOf.confirm!);
    }
    if (!voided && stage === "confirmed" && !read.pack && may("pack")) steps.push(stepsOf.pack!);
  } else {
    for (const f of [ref("pick_id", "warehouse.pick", "pack-pick"), ref("order_id", "sales.order"), ref("party_id", "core.party"), ref("warehouse_id", "inventory.warehouse")]) if (f) facts.push(f);
    facts.push(plain("packages_count", text(record.packages_count), true));
    facts.push(plain("total_weight_kg", record.total_weight_kg === null || record.total_weight_kg === undefined ? "" : `${qty(Number(record.total_weight_kg))} kg`, true));
    if (record.closed_at) facts.push(plain("closed_at", formatDayTime(text(record.closed_at), read.timeZone)));
    if (!voided && stage === "open") {
      if (may("update")) steps.push(stepsOf.update!);
      if (may("close")) steps.push(stepsOf.close!);
    }
  }
  if (record.notes) facts.push(plain("notes", text(record.notes)));

  const sourceLabel = (location: string | null, lot: string | null, serial: string | null) =>
    [location ?? t("warehouse.view.no_location"), lot ? `${t("warehouse.view.lot")} ${lot}` : null, serial ? `${t("warehouse.view.serial")} ${serial}` : null].filter(Boolean).join(" · ");
  const pickLines: PickLineView[] = read.lines.map((l) => {
    const tracking = (read.tracking.get(l.product_id) ?? "none") as PickLineView["tracking"];
    const sources = read.buckets
      .filter((b) => b.product_id === l.product_id)
      .map((b) => ({ key: bucketKey(b.location_id, b.lot_id, b.serial_id), locationId: b.location_id, lotId: b.lot_id, serialId: b.serial_id, label: `${sourceLabel(b.location, b.lot, b.serial)} (${qty(Number(b.on_hand))})` }));
    const key = bucketKey(l.location_id, l.lot_id, l.serial_id);
    const named = l.location_id || l.lot_id || l.serial_id;
    // The line's own bucket stays a choice even when it holds nothing now (the picker sees what was proposed).
    if (named && !sources.some((s) => s.key === key)) sources.unshift({ key, locationId: l.location_id, lotId: l.lot_id, serialId: l.serial_id, label: `${sourceLabel(l.location, l.lot, l.serial)} (0)` });
    return {
      id: l.id, lineNo: l.line_no, product: l.product ?? "—", productId: l.product_id, tracking, sourceKey: named ? key : "", source: named ? sourceLabel(l.location, l.lot, l.serial) : "",
      qtyRequested: Number(l.qty_requested), qtyPicked: num(l.qty_picked), shortQty: num(l.short_qty), sources,
    };
  });
  const packages: PackageView[] = read.packages.map((p) => ({
    id: p.id, packageNo: p.package_no, weightKg: num(p.weight_kg), dimensions: p.dimensions, contents: p.contents, items: Array.isArray(p.items) ? p.items : [],
  }));
  const valuesKey = isPick ? "warehouse.values.pick_stage" : "warehouse.values.pack_stage";
  return {
    kind: isPick ? "pick" : "pack",
    facts,
    stage: voided ? null : stage,
    stageLabel: !voided && stage && t.has(`${valuesKey}.${stage}`) ? t(`${valuesKey}.${stage}`) : stage,
    steps,
    pickLines,
    packages,
  };
}
