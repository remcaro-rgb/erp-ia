// The Datos tab of the inventory and costing records (plan 2B Task 10): the bodega and the ubicación (maestros), and the new movimiento,
// traslado, conteo and costo en destino (documentos that reach the stock, or the cost layers, in the action that creates them). Pure, so
// the rules (what each process takes, the sign of a quantity, what a draft still misses) are unit-tested; the forms only draw them.

/** The forms of the inventory and costing records; lot, serial and tracking are the maestros and the parametro of Task 28 (28.5). */
export type StockFormKind = "warehouse" | "location" | "movement" | "transfer" | "count" | "landed_cost" | "lot" | "serial" | "tracking";

/** The forms that edit a record in place (maestros and the parametro): saved through their create and update processes. */
export type StockMasterKind = "warehouse" | "location" | "lot" | "serial" | "tracking";
export const STOCK_MASTER_KINDS: readonly StockMasterKind[] = ["warehouse", "location", "lot", "serial", "tracking"];

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
  /** How inventory tracks the chosen product (Task 28.2): a lot line takes its lot, a serial line its numbers. */
  tracking: LineTracking;
  /** A lot line: the lot's code (a new one on an entrada creates it), and its expiry on an entrada. */
  lotCode: string;
  expiresOn: string;
  /** A serial line: the numbers as typed or scanned, separated by commas or new lines (one per unit). */
  serialNos: string;
}

/** How inventory tracks a product: untracked, by lot or by serial. */
export type LineTracking = "none" | "lot" | "serial";

/** The serial numbers typed in a line: split by commas, semicolons or new lines, trimmed, empty ones left out. */
export const serialList = (text: string): string[] => text.split(/[,;\n]/).map((s) => s.trim()).filter((s) => s !== "");

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
export const emptyLine = (): StockLine => ({
  key: `l${++lineSeq}`, productId: "", productLabel: "", locationId: "", toLocationId: "", qty: "", unitCost: "", tracking: "none", lotCode: "", expiresOn: "", serialNos: "",
});

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
    case "tracking":
      // Keyed by the product: one process creates the row or changes it (step-up).
      return "inventory.product_tracking.set";
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
    // Lots and serials (Task 28.2): a lot line names its lot; a serial line lists one number per unit.
    if (lines.some((l) => l.tracking === "lot" && l.lotCode.trim() === "")) missing.push("lot");
    if (lines.some((l) => l.tracking === "serial" && serialList(l.serialNos).length !== Math.abs(parseQty(l.qty)))) missing.push("serials");
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
  // What a line names of its lot or serials; an entrada (or a positive ajuste) also gives a new lot's expiry.
  const tracked = (l: StockLine, inbound: boolean) => {
    if (l.tracking === "lot" && l.lotCode.trim() !== "") return { lot: { code: l.lotCode.trim(), ...(inbound && l.expiresOn ? { expiresOn: l.expiresOn } : {}) } };
    if (l.tracking === "serial") return { serials: serialList(l.serialNos).map((serialNo) => ({ serialNo })) };
    return {};
  };
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
        ...tracked(l, false),
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
    const qty = draft.kind === "adjustment" ? parseQty(l.qty) : sign * Math.abs(parseQty(l.qty));
    return {
      productId: l.productId,
      ...(l.locationId ? { locationId: l.locationId } : {}),
      qty,
      ...(draft.kind === "receipt" && Number.isFinite(cost) ? { unitCost: cost } : {}),
      ...tracked(l, qty > 0),
    };
  });
  if (draft.kind === "adjustment") {
    return { ...common, warehouseId: draft.warehouseId, reason: draft.reason.trim(), lines: movementLines };
  }
  return { ...common, ...description, kind: draft.kind, warehouseId: draft.warehouseId, lines: movementLines };
}

/**
 * The draft of a bodega, ubicación, lote, serial or seguimiento por producto: the stored record, or the defaults of a new one. `labels`
 * names the references (`product_id`, `lot_id`) as the caller reads them.
 */
export interface MasterStockDraft {
  code: string;
  name: string;
  addressLine: string;
  allowBackorders: boolean;
  isActive: boolean;
  warehouseId: string;
  kind: string;
  // Lote, serial and seguimiento (Task 28.5).
  productId: string;
  productLabel: string;
  lotId: string;
  expiresOn: string;
  producedOn: string;
  /** A lot's sale status (active · blocked); apart from the maestro lifecycle. */
  lotStatus: string;
  /** A serial's status (available · issued · scrapped): kept by the movements, shown read only. */
  serialStatus: string;
  serialNo: string;
  note: string;
  tracking: string;
  fefo: boolean;
  expiryRequired: boolean;
  blockExpired: boolean;
}

/** A calendar date as the form keeps it (yyyy-mm-dd): the driver may hand it as a Date at UTC midnight. */
const dayOf = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? "" : String(v).slice(0, 10));

export function masterStockDraft(record: Readonly<Record<string, unknown>> | null, labels: Readonly<Record<string, string>> = {}): MasterStockDraft {
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return {
    code: s(record?.code),
    name: s(record?.name),
    addressLine: s(record?.address_line),
    allowBackorders: record?.allow_backorders === true,
    isActive: record ? record.is_active !== false : true,
    warehouseId: s(record?.warehouse_id),
    kind: s(record?.kind) || "storage",
    productId: s(record?.product_id),
    productLabel: labels.product_id ?? "",
    lotId: s(record?.lot_id),
    expiresOn: dayOf(record?.expires_on),
    producedOn: dayOf(record?.produced_on),
    lotStatus: s(record?.lot_status) || "active",
    serialStatus: s(record?.serial_status),
    serialNo: s(record?.serial_no),
    note: s(record?.note),
    // PG §3.1 defaults of a product without a row: untracked, FEFO on, expiry not required, expired lots blocked.
    tracking: s(record?.tracking) || "none",
    fefo: record?.fefo !== false,
    expiryRequired: record?.expiry_required === true,
    blockExpired: record?.block_expired !== false,
  };
}

/**
 * The draft of «Duplicar» of a lote or serial (rule 37): the product, the dates and the note of the source; the code or the serial number
 * cleared (unique per product), and the statuses a new one starts with (an active lot; a serial's status is the movements').
 */
export function masterStockCopy(values: Readonly<Record<string, unknown>>, labels: Readonly<Record<string, string>> = {}): MasterStockDraft {
  return { ...masterStockDraft(values, labels), code: "", serialNo: "", lotStatus: "active", serialStatus: "" };
}

/**
 * The input of the create (no id) or update process. A ubicación's bodega is set on creation only; a lote's product and code and a serial's
 * product, number and lot too (an update of a lot takes its dates, status and note, of a serial its note: its status is the movements').
 * A seguimiento is keyed by its product: inventory.product_tracking.set creates or changes the row, with no id.
 */
export function masterStockInput(kind: StockMasterKind, draft: MasterStockDraft, id: string | null): Record<string, unknown> {
  const note = draft.note.trim();
  if (kind === "lot") {
    if (id) return { id, expiresOn: draft.expiresOn || null, producedOn: draft.producedOn || null, status: draft.lotStatus, note: note || null };
    return { productId: draft.productId, code: draft.code.trim(), ...(draft.expiresOn ? { expiresOn: draft.expiresOn } : {}), ...(draft.producedOn ? { producedOn: draft.producedOn } : {}), ...(note ? { note } : {}) };
  }
  if (kind === "serial") {
    if (id) return { id, note: note || null };
    return { productId: draft.productId, serialNo: draft.serialNo.trim(), ...(draft.lotId ? { lotId: draft.lotId } : {}), ...(note ? { note } : {}) };
  }
  if (kind === "tracking") return { productId: draft.productId, tracking: draft.tracking, fefo: draft.fefo, expiryRequired: draft.expiryRequired, blockExpired: draft.blockExpired };
  const base = { ...(id ? { id } : {}), code: draft.code.trim(), name: draft.name.trim(), isActive: draft.isActive };
  if (kind === "warehouse") return { ...base, ...(draft.addressLine.trim() ? { addressLine: draft.addressLine.trim() } : {}), allowBackorders: draft.allowBackorders };
  return { ...base, ...(id ? {} : { warehouseId: draft.warehouseId }), kind: draft.kind };
}

/**
 * What the draft still misses. A bodega or ubicación answers whether anything is (its code, name, bodega); a lote, serial or seguimiento
 * names what: i18n keys under `inventory.form.missing_field` (empty when it is complete).
 */
export function masterStockMissing(kind: "warehouse" | "location", draft: MasterStockDraft, isNew: boolean): boolean;
export function masterStockMissing(kind: "lot" | "serial" | "tracking", draft: MasterStockDraft, isNew: boolean): string[];
export function masterStockMissing(kind: StockMasterKind, draft: MasterStockDraft, isNew: boolean): boolean | string[];
export function masterStockMissing(kind: StockMasterKind, draft: MasterStockDraft, isNew: boolean): boolean | string[] {
  if (kind === "warehouse" || kind === "location") return draft.code.trim() === "" || draft.name.trim() === "" || (kind === "location" && isNew && draft.warehouseId === "");
  const missing: string[] = [];
  if (draft.productId === "") missing.push("product");
  if (kind === "lot" && isNew && draft.code.trim() === "") missing.push("code");
  if (kind === "serial" && isNew && draft.serialNo.trim() === "") missing.push("serial_no");
  return missing;
}

/**
 * A row «Agregar encontrado» adds to an open conteo (Task 28.5): what the counter found that the sheet does not list. A lot product names an
 * existing lot (`lotId`) or a new code with its expiry (created nested); a serial product the number scanned (counted 1).
 */
export interface FoundRow {
  key: string;
  productId: string;
  productLabel: string;
  tracking: LineTracking;
  locationId: string;
  /** An existing lot of the product; empty: a new code. */
  lotId: string;
  lotCode: string;
  expiresOn: string;
  serialNo: string;
  countedQty: string;
}

let foundSeq = 0;
export const emptyFoundRow = (): FoundRow => ({ key: `f${++foundSeq}`, productId: "", productLabel: "", tracking: "none", locationId: "", lotId: "", lotCode: "", expiresOn: "", serialNo: "", countedQty: "" });

/** One entry of `found` of inventory.count.record (`foundInput`). */
export function foundRowInput(row: FoundRow): Record<string, unknown> {
  const tracked =
    row.tracking === "lot"
      ? row.lotId
        ? { lotId: row.lotId }
        : row.lotCode.trim()
          ? { lot: { code: row.lotCode.trim(), ...(row.expiresOn ? { expiresOn: row.expiresOn } : {}) } }
          : {}
      : row.tracking === "serial" && row.serialNo.trim()
        ? { serialNo: row.serialNo.trim() }
        : {};
  return { productId: row.productId, ...(row.locationId ? { locationId: row.locationId } : {}), ...tracked, countedQty: row.tracking === "serial" ? 1 : parseQty(row.countedQty) };
}

/** What a found row still misses: i18n keys under `inventory.count.found.missing` (empty when it can be sent). */
export function foundRowMissing(row: FoundRow): string[] {
  if (row.productId === "") return ["product"];
  // An untracked product is not «found»: the count lists it when it is created.
  if (row.tracking === "none") return ["tracked"];
  if (row.tracking === "lot" && row.lotId === "" && row.lotCode.trim() === "") return ["lot"];
  if (row.tracking === "serial") return row.serialNo.trim() === "" ? ["serial"] : [];
  const qty = parseQty(row.countedQty);
  return Number.isFinite(qty) && qty >= 0 ? [] : ["qty"];
}

/**
 * The refusal messages of «Registrar conteo» split by the found row they are about (index in `rows`): the process names a found row
 * «Encontrado N» or, for its lot and serial checks, «Línea N» (N from 1, the order sent); a message without either goes to the row whose
 * lot code or serial number it names (a nested lot or serial create). Everything else stays on the sheet.
 */
export function splitFoundMessages(messages: readonly string[], rows: readonly FoundRow[]): { rows: Record<number, string[]>; rest: string[] } {
  const byRow: Record<number, string[]> = {};
  const rest: string[] = [];
  const add = (i: number, text: string) => (byRow[i] = [...(byRow[i] ?? []), text]);
  for (const message of messages) {
    const named = /^(?:Encontrado|Línea) (\d+): ([\s\S]*)$/.exec(message);
    const n = named ? Number(named[1]) - 1 : -1;
    if (named && n >= 0 && n < rows.length) {
      add(n, named[2]!);
      continue;
    }
    const i = rows.findIndex((r) => [r.lotCode.trim(), r.serialNo.trim()].some((code) => code !== "" && message.includes(code)));
    if (i >= 0) add(i, message);
    else rest.push(message);
  }
  return { rows: byRow, rest };
}
