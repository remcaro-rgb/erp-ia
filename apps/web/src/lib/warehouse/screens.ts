import "server-only";
import { ProcessError, runnableProcesses, runProcess, withClaims, type Caller } from "@erp/kernel";
import { processDeps } from "@/lib/server/runtime";

// The Bodega screens that are not grids (plan 2B.2 Task 29.4, PG §4.4): Reglas de ubicación, Ubicar recibidos. Everything is read as the
// caller through the published views (rules 3, 14): the rules, the bodegas, the storage ubicaciones, the categories and the receipts; what
// the caller may run decides which buttons show.

export interface Option {
  id: string;
  label: string;
}
export interface LocationOption extends Option {
  warehouseId: string;
}

export interface RuleRow {
  id: string;
  warehouseId: string;
  categoryId: string | null;
  locationId: string;
  priority: number;
}

export interface RulesPageData {
  rules: RuleRow[];
  warehouses: Option[];
  categories: Option[];
  locations: LocationOption[];
  may: { create: boolean; update: boolean; delete: boolean };
}

async function places(tx: Parameters<Parameters<typeof withClaims>[2]>[0]) {
  const warehouses = await tx<{ id: string; code: string | null; name: string | null }[]>`
    select id, code, name from inventory.v_warehouses order by code`;
  const locations = await tx<{ id: string; warehouse_id: string; code: string | null; name: string | null }[]>`
    select id, warehouse_id, code, name from inventory.v_locations where kind = 'storage' and warehouse_id is not null order by code`;
  return {
    warehouses: warehouses.map((w) => ({ id: w.id, label: [w.code, w.name].filter(Boolean).join(" · ") })),
    locations: locations.map((l) => ({ id: l.id, warehouseId: l.warehouse_id, label: [l.code, l.name].filter(Boolean).join(" · ") })),
  };
}

export async function rulesPageData(caller: Caller): Promise<RulesPageData> {
  const deps = processDeps();
  const read = await withClaims(deps.sql, caller.claims, async (tx) => {
    const rules = await tx<{ id: string; warehouse_id: string | null; category_id: string | null; location_id: string | null; priority: number | null }[]>`
      select id, warehouse_id, category_id, location_id, priority from warehouse.v_putaway_rules order by priority nulls last, seq`;
    const categories = await tx<{ id: string; name: string | null }[]>`select id, name from core.v_product_categories where status = 'active' order by name`;
    return { rules, categories, ...(await places(tx)) };
  });
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, ["warehouse.putaway_rule.create", "warehouse.putaway_rule.update", "warehouse.putaway_rule.delete"]);
  return {
    rules: read.rules.flatMap((r) => (r.warehouse_id && r.location_id ? [{ id: r.id, warehouseId: r.warehouse_id, categoryId: r.category_id, locationId: r.location_id, priority: r.priority ?? 0 }] : [])),
    warehouses: read.warehouses,
    categories: read.categories.map((c) => ({ id: c.id, label: c.name ?? c.id })),
    locations: read.locations,
    may: { create: runnable.has("warehouse.putaway_rule.create"), update: runnable.has("warehouse.putaway_rule.update"), delete: runnable.has("warehouse.putaway_rule.delete") },
  };
}

export interface ReceiptOption extends Option {
  warehouseId: string;
}

export interface PutawayPageData {
  receipts: ReceiptOption[];
  locations: LocationOption[];
  /** The movement the page opened on (`?movement=`, the «Entrada por ubicar» recommendation's link). */
  selected: string | null;
  /** The suggestion of the selected receipt, read on the server. */
  initial: { listed: boolean; reason?: string; lines: SuggestionLineView[] } | null;
  mayConfirm: boolean;
}

/** The receipts still in the stock (the latest 100), newest first, and the storage ubicaciones they may go to. */
export async function putawayPageData(caller: Caller, selected: string | null): Promise<PutawayPageData> {
  const deps = processDeps();
  const read = await withClaims(deps.sql, caller.claims, async (tx) => {
    const receipts = await tx<{ id: string; number: string | null; date: string | null; reference: string | null; warehouse_id: string; warehouse: string | null }[]>`
      select m.id, m.number, m.date::text, m.reference, m.warehouse_id, w.name as warehouse
      from inventory.v_movements m left join inventory.v_warehouses w on w.id = m.warehouse_id
      where m.kind = 'receipt' and m.status <> 'voided' and m.warehouse_id is not null
      order by m.seq desc limit 100`;
    return { receipts, ...(await places(tx)) };
  });
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, ["warehouse.putaway.confirm"]);
  const chosen = selected && read.receipts.some((r) => r.id === selected) ? selected : null;
  let initial: PutawayPageData["initial"] = null;
  if (chosen) {
    try {
      const out = (await runProcess(deps, caller, "warehouse.putaway.suggest", { movementId: chosen })) as { listed: boolean; reason?: string; lines: Parameters<typeof labelSuggestion>[1] };
      initial = { listed: out.listed, ...(out.reason ? { reason: out.reason } : {}), lines: await labelSuggestion(caller, out.lines) };
    } catch (error) {
      if (!(error instanceof ProcessError)) throw error;
    }
  }
  return {
    receipts: read.receipts.map((r) => ({ id: r.id, warehouseId: r.warehouse_id, label: [r.number, r.date, r.reference, r.warehouse].filter(Boolean).join(" · ") })),
    locations: read.locations,
    selected: chosen,
    initial,
    mayConfirm: runnable.has("warehouse.putaway.confirm"),
  };
}

export interface SuggestionLineView {
  productId: string;
  product: string;
  lotId: string | null;
  lot: string | null;
  serialId: string | null;
  serial: string | null;
  qty: number;
  fromLocationId: string | null;
  from: string | null;
  toLocationId: string | null;
  basis: string;
}

/** The names of what a suggestion names by id, read as the caller. */
export async function labelSuggestion(
  caller: Caller,
  lines: { productId: string; lotId: string | null; serialId: string | null; qty: number; fromLocationId: string | null; toLocationId: string | null; basis: string }[],
): Promise<SuggestionLineView[]> {
  if (lines.length === 0) return [];
  const deps = processDeps();
  const ids = (pick: (l: (typeof lines)[number]) => string | null) => [...new Set(lines.map(pick).filter((x): x is string => !!x))];
  const names = await withClaims(deps.sql, caller.claims, async (tx) => {
    const products = await tx<{ id: string; label: string | null }[]>`select id, coalesce(sku || ' · ', '') || coalesce(description, '') as label from core.v_products where id = any(${ids((l) => l.productId)}::uuid[])`;
    const lots = await tx<{ id: string; code: string | null }[]>`select id, code from inventory.v_lots where id = any(${ids((l) => l.lotId)}::uuid[])`;
    const serials = await tx<{ id: string; serial_no: string | null }[]>`select id, serial_no from inventory.v_serials where id = any(${ids((l) => l.serialId)}::uuid[])`;
    const locations = await tx<{ id: string; label: string | null }[]>`select id, coalesce(code, name) as label from inventory.v_locations where id = any(${ids((l) => l.fromLocationId)}::uuid[])`;
    return {
      product: new Map(products.map((r) => [r.id, r.label ?? ""])),
      lot: new Map(lots.map((r) => [r.id, r.code ?? ""])),
      serial: new Map(serials.map((r) => [r.id, r.serial_no ?? ""])),
      location: new Map(locations.map((r) => [r.id, r.label ?? ""])),
    };
  });
  return lines.map((l) => ({
    ...l,
    product: names.product.get(l.productId) || "—",
    lot: l.lotId ? (names.lot.get(l.lotId) ?? null) : null,
    serial: l.serialId ? (names.serial.get(l.serialId) ?? null) : null,
    from: l.fromLocationId ? (names.location.get(l.fromLocationId) ?? null) : null,
  }));
}
