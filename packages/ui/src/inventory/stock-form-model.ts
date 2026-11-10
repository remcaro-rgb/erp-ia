// The Datos tab of the inventory and costing records (plan 2B Task 10): the bodega and the ubicación (maestros), and the new movimiento,
// traslado, conteo and costo en destino (documentos that reach the stock, or the cost layers, in the action that creates them). Pure, so
// the rules (what each process takes, the sign of a quantity, what a draft still misses) are unit-tested; the forms only draw them.

/** The forms of the inventory and costing records. */
export type StockFormKind = "warehouse" | "location" | "movement" | "transfer" | "count" | "landed_cost";

/** The kinds of movement a user registers in the Movimientos form; the transfer legs and the sale issues come from their documents. */
export const FORM_MOVEMENT_KINDS = ["receipt", "issue", "adjustment"] as const;
export type FormMovementKind = (typeof FORM_MOVEMENT_KINDS)[number];

/** The bases a landed cost is spread by in the form; `weight` needs each line's weight, which the receipt does not carry (API only). */
export const FORM_LANDED_BASES = ["value", "quantity"] as const;
export const FORM_OFFSET_ROLES = ["payable", "supplier_advances", "cash", "bank", "suspense"] as const;
/** The offset roles whose credit is owed to a supplier: the ledger asks for the tercero. */
export const OWED_ROLES: readonly string[] = ["payable", "supplier_advances"];

export interface StockLine {
  /** A stable key for React. */
  key: string;
  productId: string;
  /** The product as the box shows it (`SKU · descripción`). */
  productLabel: string;
  locationId: string;
  toLocationId: string;
  /** As typed: positive for an entrada or salida (the form signs it), signed for an ajuste. */
  qty: string;
  unitCost: string;
}

export interface StockDraft {
  kind: FormMovementKind;
  date: string;
  warehouseId: string;
  toWarehouseId: string;
  reference: string;
  description: string;
  reason: string;
  // A landed cost.
  movementId: string;
  movementLabel: string;
  amount: string;
  basis: string;
  offsetRole: string;
  partyId: string;
  partyLabel: string;
  /** A landed cost (Task 45): the cost center of the cost of sales part, the share of units already sold. */
  costCenterId: string;
  costCenterLabel: string;
  lines: StockLine[];
}

let lineSeq = 0;
/** An empty line. */
export const emptyLine = (): StockLine => ({ key: `l${++lineSeq}`, productId: "", productLabel: "", locationId: "", toLocationId: "", qty: "", unitCost: "" });

/** A new document's draft: today, the only bodega when there is one, one empty line. */
export function stockDraft(today: string, warehouses: readonly { code: string }[] = []): StockDraft {
  return {
    kind: "receipt",
    date: today,
    warehouseId: warehouses.length === 1 ? warehouses[0]!.code : "",
    toWarehouseId: "",
    reference: "",
    description: "",
    reason: "",
    movementId: "",
    movementLabel: "",
    amount: "",
    basis: "value",
    offsetRole: "payable",
    partyId: "",
    partyLabel: "",
    costCenterId: "",
    costCenterLabel: "",
    lines: [emptyLine()],
  };
}

/** A number as typed (es-CO decimal comma or dot, thousands dots when there is a comma); NaN when it is not one. */
export function parseQty(text: string): number {
  const t = text.trim().replace(/\s/g, "");
  if (t === "") return Number.NaN;
  const normal = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  return /^[-+]?\d+(\.\d+)?$/.test(normal) ? Number(normal) : Number.NaN;
}

/** The lines the user filled (a product chosen); an empty trailing line is not sent. */
export const filledLines = (draft: StockDraft): StockLine[] => draft.lines.filter((l) => l.productId !== "");

/** The process each form creates through. */
export function createProcess(kind: StockFormKind, draft: StockDraft | null): string {
  switch (kind) {
    case "movement":
      return draft?.kind === "adjustment" ? "inventory.adjustment.post" : "inventory.movement.post";
    case "transfer":
      return "inventory.transfer.create";
    case "count":
      return "inventory.count.create";
    case "landed_cost":
      return "costing.landed_cost.allocate";
    default:
      return `inventory.${kind}.create`;
  }
}

/** What the draft still misses before it can be sent: i18n keys under `inventory.form.missing` (empty when it is complete). */
export function stockMissing(kind: StockFormKind, draft: StockDraft): string[] {
  const missing: string[] = [];
  if (kind === "landed_cost") {
    if (draft.movementId === "") missing.push("receipt");
    if (!(parseQty(draft.amount) > 0)) missing.push("amount");
    if (OWED_ROLES.includes(draft.offsetRole) && draft.partyId === "") missing.push("party");
    return missing;
  }
  if (draft.date === "") missing.push("date");
  if (draft.warehouseId === "") missing.push("warehouse");
  if (kind === "transfer" && (draft.toWarehouseId === "" || draft.toWarehouseId === draft.warehouseId)) missing.push("to_warehouse");
  if (kind === "movement" && draft.kind === "adjustment" && draft.reason.trim().length < 3) missing.push("reason");
  const lines = filledLines(draft);
  if (lines.length === 0) missing.push("lines");
  if (kind !== "count") {
    const bad = lines.some((l) => {
      const q = parseQty(l.qty);
      return !Number.isFinite(q) || q === 0 || (kind === "transfer" || (kind === "movement" && draft.kind !== "adjustment") ? q < 0 : false);
    });
    if (bad) missing.push("qty");
  }
  return missing;
}

/**
 * The input of the create process. An entrada adds the typed quantity and a salida takes it (the process wants signed quantities); an
 * ajuste keeps the sign the user typed. A landed cost names its form submit (`idempotencyKey`): a retry answers the first allocation.
 */
export function stockInput(kind: StockFormKind, draft: StockDraft, idempotencyKey?: string): Record<string, unknown> {
  const description = draft.description.trim() ? { description: draft.description.trim() } : {};
  if (kind === "landed_cost") {
    return {
      movementId: draft.movementId,
      amount: parseQty(draft.amount),
      basis: draft.basis,
      offsetRole: draft.offsetRole,
      ...(draft.partyId ? { partyId: draft.partyId } : {}),
      ...(draft.costCenterId ? { costCenterId: draft.costCenterId } : {}),
      ...(draft.date ? { date: draft.date } : {}),
      ...(draft.reference.trim() ? { reference: draft.reference.trim() } : {}),
      ...description,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }
  const lines = filledLines(draft);
  const common = {
    date: draft.date,
    ...(draft.reference.trim() ? { reference: draft.reference.trim() } : {}),
  };
  if (kind === "transfer") {
    return {
      ...common,
      ...description,
      fromWarehouseId: draft.warehouseId,
      toWarehouseId: draft.toWarehouseId,
      lines: lines.map((l) => ({
        productId: l.productId,
        ...(l.locationId ? { fromLocationId: l.locationId } : {}),
        ...(l.toLocationId ? { toLocationId: l.toLocationId } : {}),
        qty: parseQty(l.qty),
      })),
    };
  }
  if (kind === "count") {
    return {
      date: draft.date,
      warehouseId: draft.warehouseId,
      ...description,
      lines: lines.map((l) => ({ productId: l.productId, ...(l.locationId ? { locationId: l.locationId } : {}) })),
    };
  }
  const sign = draft.kind === "issue" ? -1 : 1;
  const movementLines = lines.map((l) => {
    const cost = parseQty(l.unitCost);
    return {
      productId: l.productId,
      ...(l.locationId ? { locationId: l.locationId } : {}),
      qty: draft.kind === "adjustment" ? parseQty(l.qty) : sign * Math.abs(parseQty(l.qty)),
      ...(draft.kind === "receipt" && Number.isFinite(cost) ? { unitCost: cost } : {}),
    };
  });
  if (draft.kind === "adjustment") {
    return { ...common, warehouseId: draft.warehouseId, reason: draft.reason.trim(), lines: movementLines };
  }
  return { ...common, ...description, kind: draft.kind, warehouseId: draft.warehouseId, lines: movementLines };
}

/** The draft of a bodega or ubicación: the stored record, or the defaults of a new one. */
export interface MasterStockDraft {
  code: string;
  name: string;
  addressLine: string;
  allowBackorders: boolean;
  isActive: boolean;
  warehouseId: string;
  kind: string;
}

export function masterStockDraft(record: Readonly<Record<string, unknown>> | null): MasterStockDraft {
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return {
    code: s(record?.code),
    name: s(record?.name),
    addressLine: s(record?.address_line),
    allowBackorders: record?.allow_backorders === true,
    isActive: record ? record.is_active !== false : true,
    warehouseId: s(record?.warehouse_id),
    kind: s(record?.kind) || "storage",
  };
}

/** The input of the bodega's or ubicación's create (no id) or update process. A ubicación's bodega is set on creation only. */
export function masterStockInput(kind: "warehouse" | "location", draft: MasterStockDraft, id: string | null): Record<string, unknown> {
  const base = { ...(id ? { id } : {}), code: draft.code.trim(), name: draft.name.trim(), isActive: draft.isActive };
  if (kind === "warehouse") return { ...base, ...(draft.addressLine.trim() ? { addressLine: draft.addressLine.trim() } : {}), allowBackorders: draft.allowBackorders };
  return { ...base, ...(id ? {} : { warehouseId: draft.warehouseId }), kind: draft.kind };
}

export function masterStockMissing(kind: "warehouse" | "location", draft: MasterStockDraft, isNew: boolean): boolean {
  return draft.code.trim() === "" || draft.name.trim() === "" || (kind === "location" && isNew && draft.warehouseId === "");
}
