import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costingHarness, good, layerOf, warehouse, type CostingHarness, type OutboxRow } from "./helpers";

// Landed costs through the real posting engine on the demo chart (plan 2B Task 9, design §8.1): costing.landed_cost.allocate spreads an
// amount over the lines of a valued receipt by value, quantity or weight and raises their layers; the document posts Dr inventory (per line)
// / Cr the offset role through the rules the costing manifest ships, INLINE and strict in the same transaction (D8): a ledger refusal undoes
// the whole action; costing.settings accepts the average method only.

let h: CostingHarness;
let w: { id: string; locationId: string };
let year: number;
let supplierId: string;
const date = () => `${year}-03-15`;

const product = async (sku: string, overrides: Record<string, unknown> = {}) => (await h.run<{ id: string }>(h.admin, "core.product.create", good(sku, overrides))).id;
const receipt = async (lines: { productId: string; qty: number; unitCost?: number }[]) => {
  const { id } = await h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind: "receipt", date: date(), warehouseId: w.id, lines: lines.map((l) => ({ locationId: w.locationId, ...l })) });
  await h.deliver(await h.movementEvent(id), "costing");
  return id;
};
const lineIds = async (movementId: string) =>
  (await h.sql<{ id: string }[]>`select id from inventory.movement_lines where movement_id = ${movementId} order by line_no`).map((r) => r.id);
type Allocated = { id: string; number: string | null; status: string; amount: number; lines: { lineId: string; movementLineId: string; productId: string; amount: number; unitCostAdded: number }[] };
const allocate = (input: Record<string, unknown>) => h.run<Allocated>(h.admin, "costing.landed_cost.allocate", { date: date(), offsetRole: "payable", partyId: supplierId, ...input })
const allocatedEvent = async (landedId: string): Promise<OutboxRow> => {
  const rows = await h.sql<OutboxRow[]>`
    select id, event, payload, created_at, chain_id from kernel.outbox where event = 'costing.landed_cost.allocated' and payload->>'landedCostId' = ${landedId}`;
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
const entriesOf = (eventId: string) => h.sql<{ id: string; status: string; total_debit: string; total_credit: string; source_entity: string; source_record_id: string; chain_id: string; description: string }[]>`
  select id, status, total_debit, total_credit, source_entity, source_record_id, chain_id, description from accounting.entries where company_id = ${h.companyId} and source_event_id = ${eventId}`;
const linesOf = (entryId: string) => h.sql<{ code: string; debit: string; credit: string }[]>`
  select a.code, l.debit, l.credit from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entryId} order by l.line_no`;
const roleCode = async (role: string) =>
  (await h.sql<{ code: string }[]>`
    select a.code from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
    where m.company_id = ${h.companyId} and m.role = ${role} and m.dimension is null`)[0]!.code;
const layerEvents = (productId: string) => h.sql<{ kind: string; qty: string; amount: string; value_after: string; source_id: string | null }[]>`
  select kind, qty, amount, value_after, source_id from costing.cost_events where company_id = ${h.companyId} and product_id = ${productId} order by seq`;
const sumOfEvents = async (productId: string) =>
  Number((await h.sql<{ s: string }[]>`select coalesce(sum(amount), 0) as s from costing.cost_events where company_id = ${h.companyId} and product_id = ${productId}`)[0]!.s);

beforeAll(async () => {
  h = await costingHarness({ accounting: true });
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
  w = await warehouse(h, "LND");
  supplierId = (await h.run<{ id: string }>(h.admin, "core.party.create", {
    kind: ["supplier"], personType: "1", documentType: "31", documentNumber: "900123456", legalName: "Transportes del Norte S.A.S.", taxResponsibilities: ["O-13"],
    taxScheme: "01", countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@transportes.com",
  })).id;
  // A tercero the ledger accepts is invoice_ready (rule 10): its DIAN data is complete and it holds the files its kind requires.
  await h.sql`update core.parties set dian_status = 'complete' where id = ${supplierId}`;
  for (const tag of ["RUT", "Cámara de Comercio"]) {
    await h.sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
      values (${h.companyId}, 'core.party', ${supplierId}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024,
        ${`${h.seed.tenantId}/${h.companyId}/core.party/${supplierId}/${randomUUID()}-${tag}.pdf`})`;
  }
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

describe("the costing manifest ships its posting rules", () => {
  it("the company has one rule per offset role for the allocation and the reversal rule of the void", async () => {
    const rules = await h.sql<{ event: string; name: string; module: string; is_default: boolean; is_active: boolean; template: { when?: { equals: string }[]; reverseOf: unknown } }[]>`
      select event, name, module, is_default, is_active, template from accounting.posting_rules
      where company_id = ${h.companyId} and event like 'costing.landed_cost.%' order by event, name`;
    expect(rules.every((r) => r.module === "costing" && r.is_default && r.is_active)).toBe(true);
    expect(rules.filter((r) => r.event === "costing.landed_cost.allocated").flatMap((r) => r.template.when!.map((c) => c.equals)).sort()).toEqual(
      ["bank", "cash", "payable", "supplier_advances", "suspense"],
    );
    expect(rules.filter((r) => r.event === "costing.landed_cost.voided")).toHaveLength(1);
    expect(rules.find((r) => r.event === "costing.landed_cost.voided")!.template.reverseOf).toEqual({ event: "costing.landed_cost.allocated", sourceId: "$.landedCostId" });
  });
});

describe("allocation by value", () => {
  let a: string;
  let b: string;
  let movement: string;
  let landed: Allocated;

  it("raises each layer's value and average; the increments add up to the amount to the cent", async () => {
    a = await product("LC-V1");
    b = await product("LC-V2");
    movement = await receipt([{ productId: a, qty: 10, unitCost: 100 }, { productId: b, qty: 20, unitCost: 200 }]);
    // Values 1.000 and 4.000: 1/5 and 4/5 of 1.000,01 (1000.01 -> 200.00 + 800.01 with the odd cent to the larger remainder).
    landed = await allocate({ movementId: movement, amount: 1000.01, basis: "value", reference: "FLETE-1", idempotencyKey: "k1" });
    expect(landed.status).toBe("posted");
    expect(landed.number).toMatch(/^CD-\d+$/);
    const shares = landed.lines.map((l) => l.amount);
    expect(shares.reduce((s, x) => Math.round((s + x) * 100) / 100, 0)).toBe(1000.01);
    expect(shares).toEqual([200, 800.01]);
    expect(await layerOf(h, a, w.id)).toEqual({ qty: 10, value: 1200, avgCost: 120 });
    expect(await layerOf(h, b, w.id)).toEqual({ qty: 20, value: 4800.01, avgCost: 240.0005 });
    expect(landed.lines.map((l) => l.unitCostAdded)).toEqual([20, 40.0005]);
  });

  it("records each share as a cost event of kind landed_cost (qty 0) so the layer's value is the sum of its events", async () => {
    const events = await layerEvents(a);
    expect(events.map((e) => [e.kind, Number(e.qty), Number(e.amount), Number(e.value_after)])).toEqual([["receipt", 10, 1000, 1000], ["landed_cost", 0, 200, 1200]]);
    expect(events[1]!.source_id).toBe(landed.id);
    expect(await sumOfEvents(a)).toBe(1200);
    expect(await sumOfEvents(b)).toBe(4800.01);
  });

  it("a replay with the same key answers the first result and allocates nothing twice", async () => {
    const again = await allocate({ movementId: movement, amount: 1000.01, basis: "value", reference: "FLETE-1", idempotencyKey: "k1" });
    expect(again).toEqual(landed);
    expect(await layerOf(h, a, w.id)).toEqual({ qty: 10, value: 1200, avgCost: 120 });
    const [n] = await h.sql<{ n: number }[]>`select count(*)::int as n from costing.landed_costs where company_id = ${h.companyId} and movement_id = ${movement}`;
    expect(n!.n).toBe(1);
  });

  it("posts one balanced entry in the same action: Dr inventory per line / Cr cuentas por pagar, linked to the landed cost and its event", async () => {
    const row = await allocatedEvent(landed.id);
    // The entry exists as soon as the action committed, keyed by the event the action emitted (no consumer ran).
    const entries = await entriesOf(row.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: "posted", total_debit: "1000.0100", total_credit: "1000.0100", source_entity: "costing.landed_cost", source_record_id: landed.id,
      chain_id: row.chain_id, description: `Costo en destino ${landed.number}`,
    });
    expect((await linesOf(entries[0]!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      [await roleCode("inventory"), "200.0000", "0.0000"],
      [await roleCode("inventory"), "800.0100", "0.0000"],
      [await roleCode("payable"), "0.0000", "1000.0100"],
    ]);
    // The asynchronous accounting consumer receives the same event later and posts nothing twice, records nothing.
    await h.deliver(row, "accounting");
    await h.deliver(row, "accounting");
    expect(await entriesOf(row.id)).toHaveLength(1);
    expect(await h.sql`select error_code from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${row.id}`).toEqual([]);
    const [total] = await h.sql<{ n: number }[]>`select count(*)::int as n from accounting.entries where company_id = ${h.companyId} and source_record_id = ${landed.id}`;
    expect(total!.n).toBe(1);
  });

  it("several allocations on one receipt are additive", async () => {
    const second = await allocate({ movementId: movement, amount: 500, basis: "value" });
    expect(second.id).not.toBe(landed.id);
    expect(await layerOf(h, a, w.id)).toEqual({ qty: 10, value: 1300, avgCost: 130 });
    expect(await sumOfEvents(a)).toBe(1300);
  });
});

describe("allocation by quantity and by weight", () => {
  it("by quantity: 600 over 10 and 20 units is 200 and 400", async () => {
    const a = await product("LC-Q1");
    const b = await product("LC-Q2");
    const movement = await receipt([{ productId: a, qty: 10, unitCost: 50 }, { productId: b, qty: 20, unitCost: 1000 }]);
    const landed = await allocate({ movementId: movement, amount: 600, basis: "quantity", offsetRole: "cash" });
    expect(landed.lines.map((l) => l.amount)).toEqual([200, 400]);
    expect(await layerOf(h, a, w.id)).toEqual({ qty: 10, value: 700, avgCost: 70 });
    expect(await layerOf(h, b, w.id)).toEqual({ qty: 20, value: 20_400, avgCost: 1020 });
  });

  it("by weight: the request gives each line's weight (the product has none); 100 over 1 kg and 2 kg is 33,33 and 66,67", async () => {
    const a = await product("LC-W1");
    const b = await product("LC-W2");
    const movement = await receipt([{ productId: a, qty: 4, unitCost: 10 }, { productId: b, qty: 4, unitCost: 10 }]);
    const [l1, l2] = await lineIds(movement);
    const landed = await allocate({ movementId: movement, amount: 100, basis: "weight", weights: [{ lineId: l1!, weight: 1 }, { lineId: l2!, weight: 2 }] });
    expect(landed.lines.map((l) => l.amount)).toEqual([33.33, 66.67]);
    expect(await layerOf(h, a, w.id)).toEqual({ qty: 4, value: 73.33, avgCost: 18.3325 });
    expect(await layerOf(h, b, w.id)).toEqual({ qty: 4, value: 106.67, avgCost: 26.6675 });
    const [saved] = await h.sql<{ weight: string }[]>`select weight from costing.landed_cost_lines where landed_cost_id = ${landed.id} order by line_no`;
    expect(Number(saved!.weight)).toBe(1);
  });

  it("by weight without a weight for every line is refused, and nothing is written", async () => {
    const a = await product("LC-W3");
    const movement = await receipt([{ productId: a, qty: 4, unitCost: 10 }]);
    await expect(allocate({ movementId: movement, amount: 100, basis: "weight" })).rejects.toThrow(/weights_required/);
    expect(await layerOf(h, a, w.id)).toEqual({ qty: 4, value: 40, avgCost: 10 });
    const [n] = await h.sql<{ n: number }[]>`select count(*)::int as n from costing.landed_costs where company_id = ${h.companyId} and movement_id = ${movement}`;
    expect(n!.n).toBe(0);
  });
});

describe("refusals", () => {
  it("a voided receipt, a missing supplier, weights given for another basis, and unknown or repeated weight lines are refused", async () => {
    const p = await product("LC-R0");
    const movement = await receipt([{ productId: p, qty: 4, unitCost: 10 }]);
    const [l1] = await lineIds(movement);
    await expect(allocate({ movementId: movement, amount: 10, basis: "value", partyId: undefined })).rejects.toThrow(/party_required/);
    await expect(allocate({ movementId: movement, amount: 10, basis: "value", weights: [{ lineId: l1!, weight: 1 }] })).rejects.toThrow(/weights_not_applicable/);
    await expect(allocate({ movementId: movement, amount: 10, basis: "weight", weights: [{ lineId: l1!, weight: 1 }, { lineId: randomUUID(), weight: 1 }] })).rejects.toThrow(/weights_required/);
    await expect(allocate({ movementId: movement, amount: 10, basis: "weight", weights: [{ lineId: l1!, weight: 1 }, { lineId: l1!, weight: 2 }] })).rejects.toThrow(/weights_required/);
    await h.run(h.admin, "inventory.movement.void", { id: movement, reason: "Recibido por error" });
    await expect(allocate({ movementId: movement, amount: 10, basis: "value" })).rejects.toThrow(/movement_voided/);
    expect(await layerEvents(p).then((e) => e.filter((x) => x.kind === "landed_cost"))).toEqual([]);
  });

  it("a movement that is not a receipt, or not valued yet, is refused", async () => {
    const p = await product("LC-R1");
    await receipt([{ productId: p, qty: 10, unitCost: 10 }]);
    const issue = (await h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind: "issue", date: date(), warehouseId: w.id, lines: [{ productId: p, locationId: w.locationId, qty: -2 }] })).id;
    await h.deliver(await h.movementEvent(issue), "costing");
    await expect(allocate({ movementId: issue, amount: 50, basis: "value" })).rejects.toThrow(/not_a_receipt/);
    const fresh = (await h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind: "receipt", date: date(), warehouseId: w.id, lines: [{ productId: p, locationId: w.locationId, qty: 1, unitCost: 5 }] })).id;
    await expect(allocate({ movementId: fresh, amount: 50, basis: "value" })).rejects.toThrow(/movement_not_costed/);
    await expect(allocate({ movementId: randomUUID(), amount: 50, basis: "value" })).rejects.toThrow(/movement_not_costed/);
  });

  it("a receipt whose lines are all worth zero cannot be split by value", async () => {
    const p = await product("LC-R2");
    const movement = await receipt([{ productId: p, qty: 3 }]);
    await expect(allocate({ movementId: movement, amount: 50, basis: "value" })).rejects.toThrow(/nothing_to_distribute/);
    const landed = await allocate({ movementId: movement, amount: 50, basis: "quantity" });
    expect(landed.lines.map((l) => l.amount)).toEqual([50]);
  });

  it("a non-positive amount and an amount with more than two decimals are refused", async () => {
    const p = await product("LC-R3");
    const movement = await receipt([{ productId: p, qty: 1, unitCost: 10 }]);
    await expect(allocate({ movementId: movement, amount: 0, basis: "value" })).rejects.toThrow();
    await expect(allocate({ movementId: movement, amount: 10.005, basis: "value" })).rejects.toThrow();
  });

  it("units of the receipt already issued are not restated: the allocation raises the value of what remains", async () => {
    const p = await product("LC-I1");
    const movement = await receipt([{ productId: p, qty: 10, unitCost: 100 }]);
    const issue = (await h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind: "issue", date: date(), warehouseId: w.id, lines: [{ productId: p, locationId: w.locationId, qty: -6 }] })).id;
    await h.deliver(await h.movementEvent(issue), "costing");
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 4, value: 400, avgCost: 100 });
    await allocate({ movementId: movement, amount: 200, basis: "value" });
    // The 6 units issued keep their cost of 600; the 200 raises the 4 that remain to 150 each.
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 4, value: 600, avgCost: 150 });
    expect(await sumOfEvents(p)).toBe(600);
  });

  it("when no unit remains the value stays in the layer and the next entry's average carries it", async () => {
    const p = await product("LC-I2");
    const movement = await receipt([{ productId: p, qty: 2, unitCost: 100 }]);
    const issue = (await h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind: "issue", date: date(), warehouseId: w.id, lines: [{ productId: p, locationId: w.locationId, qty: -2 }] })).id;
    await h.deliver(await h.movementEvent(issue), "costing");
    await allocate({ movementId: movement, amount: 50, basis: "quantity" });
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 0, value: 50, avgCost: 100 });
    await receipt([{ productId: p, qty: 1, unitCost: 100 }]);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 1, value: 150, avgCost: 150 });
    expect(await sumOfEvents(p)).toBe(150);
  });
});

describe("posting with the offset role the user names", () => {
  it("credits the named role: bank", async () => {
    const p = await product("LC-O1");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    const landed = await allocate({ movementId: movement, amount: 80, basis: "value", offsetRole: "bank", partyId: undefined });
    const row = await allocatedEvent(landed.id);
    const [entry] = await entriesOf(row.id);
    expect(entry).toMatchObject({ status: "posted", total_debit: "80.0000", total_credit: "80.0000" });
    expect((await linesOf(entry!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      [await roleCode("inventory"), "80.0000", "0.0000"],
      [await roleCode("bank"), "0.0000", "80.0000"],
    ]);
  });
});

/** Everything an allocation writes, counted: the action must leave all of it unchanged when it is refused. */
const footprint = async (productId: string, movementId: string) => ({
  documents: Number((await h.sql`select count(*)::int as n from costing.landed_costs where company_id = ${h.companyId}`)[0]!.n),
  lines: Number((await h.sql`select count(*)::int as n from costing.landed_cost_lines where company_id = ${h.companyId}`)[0]!.n),
  events: await layerEvents(productId),
  layer: await layerOf(h, productId, w.id),
  entries: Number((await h.sql`select count(*)::int as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n),
  failures: Number((await h.sql`select count(*)::int as n from accounting.posting_failures where company_id = ${h.companyId}`)[0]!.n),
  outbox: Number((await h.sql`select count(*)::int as n from kernel.outbox where company_id = ${h.companyId} and event like 'costing.landed_cost.%'`)[0]!.n),
  numbers: await h.sql`select prefix, next from costing.document_numbers where company_id = ${h.companyId} order by prefix`,
  movement: movementId,
});

describe("a ledger refusal undoes the whole allocation (D8)", () => {
  it("a closed period: refused, and no document, no cost event, no entry, no posting failure, no event, no number, the layer unchanged", async () => {
    const p = await product("LC-C1");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 2`;
    const before = await footprint(p, movement);
    await expect(allocate({ movementId: movement, amount: 80, basis: "value", date: `${year}-02-10` })).rejects.toThrow(/closed_period/);
    expect(await footprint(p, movement)).toEqual(before);
    expect(before.layer).toEqual({ qty: 5, value: 200, avgCost: 40 });
    await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 2`;
    // The same request in an open period goes through.
    expect((await allocate({ movementId: movement, amount: 80, basis: "value", date: `${year}-03-10` })).status).toBe("posted");
  });

  it("a tercero that is not ready (missing_party): refused with nothing written", async () => {
    const p = await product("LC-C2");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    const unready = (await h.run<{ id: string }>(h.admin, "core.party.create", {
      kind: ["supplier"], personType: "1", documentType: "31", documentNumber: "900654321", legalName: "Proveedor sin RUT S.A.S.", taxResponsibilities: ["O-13"],
      taxScheme: "01", countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@sinrut.com",
    })).id;
    const before = await footprint(p, movement);
    await expect(allocate({ movementId: movement, amount: 80, basis: "value", partyId: unready })).rejects.toThrow(/missing_party/);
    expect(await footprint(p, movement)).toEqual(before);
  });

  it("a missing cost center: refused with nothing written", async () => {
    const p = await product("LC-C3");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    await h.sql`update accounting.accounts set requires_cost_center = true where id = (select account_id from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'inventory' and dimension is null)`;
    try {
      const before = await footprint(p, movement);
      await expect(allocate({ movementId: movement, amount: 80, basis: "value" })).rejects.toThrow(/missing_cost_center/);
      expect(await footprint(p, movement)).toEqual(before);
    } finally {
      await h.sql`update accounting.accounts set requires_cost_center = false where company_id = ${h.companyId}`;
    }
  });

  it("an unmapped role (missing_account_mapping): refused with nothing written", async () => {
    const p = await product("LC-C4");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    const [mapping] = await h.sql<{ id: string; account_id: string }[]>`
      select id, account_id from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'bank' and dimension is null`;
    await h.sql`delete from accounting.account_role_mappings where id = ${mapping!.id}`;
    try {
      const before = await footprint(p, movement);
      await expect(allocate({ movementId: movement, amount: 80, basis: "value", offsetRole: "bank" })).rejects.toThrow(/missing_account_mapping/);
      expect(await footprint(p, movement)).toEqual(before);
    } finally {
      await h.sql`insert into accounting.account_role_mappings (company_id, role, account_id) values (${h.companyId}, 'bank', ${mapping!.account_id})`;
    }
  });

  it("no active rule for the event: refused with nothing written", async () => {
    const p = await product("LC-C5");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    await h.sql`update accounting.posting_rules set is_active = false where company_id = ${h.companyId} and event = 'costing.landed_cost.allocated'`;
    try {
      const before = await footprint(p, movement);
      await expect(allocate({ movementId: movement, amount: 80, basis: "value" })).rejects.toThrow(/no_rule/);
      expect(await footprint(p, movement)).toEqual(before);
    } finally {
      await h.sql`update accounting.posting_rules set is_active = true where company_id = ${h.companyId} and event = 'costing.landed_cost.allocated'`;
    }
  });
});

describe("void", () => {
  it("takes the shares back with opposite cost events, reverses the entry in the same action and keeps the document, voided", async () => {
    const p = await product("LC-X1");
    const movement = await receipt([{ productId: p, qty: 10, unitCost: 100 }]);
    const landed = await allocate({ movementId: movement, amount: 300, basis: "value" });
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 10, value: 1300, avgCost: 130 });

    await expect(h.run(h.admin, "costing.landed_cost.void", { id: landed.id, reason: "Factura del flete mal cargada" })).rejects.toThrow(/step.?up/i);
    const out = await h.runStepUp<{ status: string; number: string }>(h.admin, "costing.landed_cost.void", { id: landed.id, reason: "Factura del flete mal cargada", date: date() });
    expect(out).toMatchObject({ status: "voided", number: landed.number });
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 10, value: 1000, avgCost: 100 });
    expect((await layerEvents(p)).map((e) => [e.kind, Number(e.amount)])).toEqual([["receipt", 1000], ["landed_cost", 300], ["landed_cost", -300]]);
    expect(await sumOfEvents(p)).toBe(1000);
    const [doc] = await h.sql<{ status: string; void_reason: string }[]>`select status, void_reason from costing.landed_costs where id = ${landed.id}`;
    expect(doc).toEqual({ status: "voided", void_reason: "Factura del flete mal cargada" });

    // The reversal is in the ledger already (two entries, the second a reversal) and the async consumer adds nothing.
    const entries = async () => h.sql<{ status: string; reversal_of_id: string | null; total_debit: string }[]>`
      select status, reversal_of_id, total_debit from accounting.entries where company_id = ${h.companyId} and source_record_id = ${landed.id} order by posted_at`;
    const found = await entries();
    expect(found).toHaveLength(2);
    expect(found[1]).toMatchObject({ status: "posted", total_debit: "300.0000" });
    expect(found[1]!.reversal_of_id).not.toBeNull();
    const [voidedRow] = await h.sql<OutboxRow[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox where event = 'costing.landed_cost.voided' and payload->>'landedCostId' = ${landed.id}`;
    await h.deliver(voidedRow!, "accounting");
    expect(await entries()).toHaveLength(2);
    expect(await h.sql`select 1 from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${voidedRow!.id}`).toEqual([]);

    // Voided once: a second void is refused, and the consult still shows the document with its lines.
    await expect(h.runStepUp(h.admin, "costing.landed_cost.void", { id: landed.id, reason: "otra vez" })).rejects.toThrow(/invalid_state|not allowed/);
    expect((await h.run<{ lines: unknown[] }>(h.admin, "costing.landed_cost.consult", { id: landed.id })).lines).toHaveLength(1);
  });

  it("is refused when the reversal is impossible (a closed period): the document, the layer and the ledger stay as they were", async () => {
    const p = await product("LC-X2");
    const movement = await receipt([{ productId: p, qty: 10, unitCost: 100 }]);
    const landed = await allocate({ movementId: movement, amount: 300, basis: "value" });
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 4`;
    try {
      const before = await footprint(p, movement);
      await expect(h.runStepUp(h.admin, "costing.landed_cost.void", { id: landed.id, reason: "Mal cargado", date: `${year}-04-10` })).rejects.toThrow(/closed_period/);
      expect(await footprint(p, movement)).toEqual(before);
      expect((await h.sql`select status from costing.landed_costs where id = ${landed.id}`)[0]).toEqual({ status: "posted" });
      expect(await layerOf(h, p, w.id)).toEqual({ qty: 10, value: 1300, avgCost: 130 });
    } finally {
      await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 4`;
    }
    // In an open period it goes through.
    expect((await h.runStepUp<{ status: string }>(h.admin, "costing.landed_cost.void", { id: landed.id, reason: "Mal cargado", date: `${year}-03-20` })).status).toBe("voided");
  });

  it("after units were issued it is allowed: it removes exactly what it added, the layer still equals the sum of its events and the ledger's inventory", async () => {
    const p = await product("LC-X3");
    const movement = await receipt([{ productId: p, qty: 10, unitCost: 100 }]);
    const landed = await allocate({ movementId: movement, amount: 300, basis: "value" });
    const issue = (await h.run<{ id: string }>(h.admin, "inventory.movement.post", { kind: "issue", date: date(), warehouseId: w.id, lines: [{ productId: p, locationId: w.locationId, qty: -8 }] })).id;
    await h.deliver(await h.movementEvent(issue), "costing");
    // 8 of 10 units left at the average of 130: 1040 taken, 260 remains for 2 units.
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 2, value: 260, avgCost: 130 });
    await h.runStepUp(h.admin, "costing.landed_cost.void", { id: landed.id, reason: "Mal cargado", date: date() });
    // The issue is not restated (it keeps 1040): the 300 comes out of what remains, which now holds 2 units worth -40.
    // (the average snapshot never goes below 0)
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 2, value: -40, avgCost: 0 });
    expect(await sumOfEvents(p)).toBe(-40);
    // The ledger agrees with the layer: the inventory movements posted by this landed cost net to zero after the reversal.
    const [net] = await h.sql<{ net: string }[]>`
      select coalesce(sum(l.debit - l.credit), 0) as net from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
      join accounting.accounts a on a.id = l.account_id
      where e.company_id = ${h.companyId} and e.source_record_id = ${landed.id} and a.code = ${await roleCode("inventory")}`;
    expect(Number(net!.net)).toBe(0);
  });
});

const handledByAccounting = async (eventId: string) =>
  (await h.sql`select 1 from kernel.outbox_deliveries where outbox_id = ${eventId} and module_id = 'accounting'`).length === 1;
const entriesOfSource = (sourceId: string) => h.sql<{ id: string; reversal_of_id: string | null; total_debit: string }[]>`
  select id, reversal_of_id, total_debit from accounting.entries where company_id = ${h.companyId} and source_record_id = ${sourceId} order by posted_at`;
const failuresCount = async () => Number((await h.sql`select count(*)::int as n from accounting.posting_failures where company_id = ${h.companyId}`)[0]!.n);
const setAccounting = (enabled: boolean) => h.sql`
  insert into kernel.company_modules (company_id, module_id, enabled, enabled_at) values (${h.companyId}, 'accounting', ${enabled}, now())
  on conflict (company_id, module_id) do update set enabled = ${enabled}`;
const eventOf = async (name: string, landedId: string): Promise<OutboxRow> => {
  const rows = await h.sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where event = ${name} and payload->>'landedCostId' = ${landedId}`;
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe("inline posting is the ledger rules' decision, not the caller's rights", () => {
  it("a member holding only costing processes allocates and voids even when the accounts are restricted to others", async () => {
    const p = await product("LC-A1");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    const accounts = [await roleCode("inventory"), await roleCode("payable")];
    await h.sql`update accounting.accounts set access = 'restricted' where company_id = ${h.companyId} and code = any(${accounts}::text[])`;
    try {
      const landed = await h.run<Allocated>(h.clerk, "costing.landed_cost.allocate", { movementId: movement, amount: 80, basis: "value", offsetRole: "payable", partyId: supplierId, date: date() });
      expect(await entriesOfSource(landed.id)).toHaveLength(1);
      await h.runStepUp(h.clerk, "costing.landed_cost.void", { id: landed.id, reason: "Mal cargado", date: date() });
      expect((await entriesOfSource(landed.id)).map((e) => e.reversal_of_id !== null)).toEqual([false, true]);
      expect(await layerOf(h, p, w.id)).toEqual({ qty: 5, value: 200, avgCost: 40 });
    } finally {
      await h.sql`update accounting.accounts set access = 'open' where company_id = ${h.companyId} and code = any(${accounts}::text[])`;
    }
  });

  it("a record rule that hides the entry from the voider neither skips the reversal nor refuses it: the entry is reversed", async () => {
    const p = await product("LC-A2");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    const landed = await allocate({ movementId: movement, amount: 80, basis: "value" });
    const [entry] = await entriesOfSource(landed.id);
    const adminRole = h.seed.companies[0]!.adminRoleId;
    await h.sql`insert into kernel.record_access (company_id, entity, record_id, grantee_role_id, can_read) values (${h.companyId}, 'accounting.entry', ${entry!.id}, ${adminRole}, true)`;
    await h.runStepUp(h.clerk, "costing.landed_cost.void", { id: landed.id, reason: "Mal cargado", date: date() });
    const found = await entriesOfSource(landed.id);
    expect(found).toHaveLength(2);
    expect(found[1]!.reversal_of_id).toBe(entry!.id);
    expect(await layerOf(h, p, w.id)).toEqual({ qty: 5, value: 200, avgCost: 40 });
  });
});

describe("the asynchronous consumer leaves an inline-posted event alone", () => {
  it("after the mapping is removed, a rule added and the ledger start moved, delivering the event writes no failure and no second entry", async () => {
    const p = await product("LC-B1");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    const landed = await allocate({ movementId: movement, amount: 80, basis: "value" });
    const row = await eventOf("costing.landed_cost.allocated", landed.id);
    expect(await handledByAccounting(row.id)).toBe(true);
    const [mapping] = await h.sql<{ id: string; account_id: string }[]>`select id, account_id from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'payable' and dimension is null`;
    const [rule] = await h.sql<{ journal_id: string; template: unknown }[]>`select journal_id, template from accounting.posting_rules where company_id = ${h.companyId} and event = 'costing.landed_cost.allocated' and name like '%pagar%'`;
    await h.sql`delete from accounting.account_role_mappings where id = ${mapping!.id}`;
    const [extra] = await h.sql<{ id: string }[]>`
      insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default) values (${h.companyId}, 'costing.landed_cost.allocated', 'Regla nueva', 'costing', ${rule!.journal_id}, ${h.sql.json(rule!.template as never)}, 50, false) returning id`;
    await h.sql`update accounting.settings set ledger_starts_on = ${`${year + 1}-01-01`} where company_id = ${h.companyId}`;
    try {
      await h.deliver(row, "accounting");
      await h.deliver(row, "accounting");
      expect(await entriesOf(row.id)).toHaveLength(1);
      expect(await h.sql`select 1 from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${row.id}`).toEqual([]);
      expect(await h.sql`select 1 from accounting.skipped_events where company_id = ${h.companyId} and outbox_id = ${row.id}`).toEqual([]);
    } finally {
      await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
      await h.sql`delete from accounting.posting_rules where id = ${extra!.id}`;
      await h.sql`insert into accounting.account_role_mappings (company_id, role, account_id) values (${h.companyId}, 'payable', ${mapping!.account_id})`;
    }
  });

  it("an event dated before the ledger start is skipped inline (counted, marked handled): no entry, no failure, and the void reverses nothing", async () => {
    const p = await product("LC-B2");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-06-01`} where company_id = ${h.companyId}`;
    try {
      const landed = await allocate({ movementId: movement, amount: 80, basis: "value" });
      const row = await eventOf("costing.landed_cost.allocated", landed.id);
      expect(await entriesOf(row.id)).toEqual([]);
      expect(await handledByAccounting(row.id)).toBe(true);
      expect(await h.sql`select 1 from accounting.skipped_events where company_id = ${h.companyId} and outbox_id = ${row.id}`).toHaveLength(1);
      await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
      await h.deliver(row, "accounting");
      expect(await entriesOf(row.id)).toEqual([]);
      expect(await failuresCount()).toBe(0);
      await h.runStepUp(h.admin, "costing.landed_cost.void", { id: landed.id, reason: "Mal cargado", date: date() });
      expect(await entriesOfSource(landed.id)).toEqual([]);
      expect(await layerOf(h, p, w.id)).toEqual({ qty: 5, value: 200, avgCost: 40 });
    } finally {
      await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
    }
  });
});

describe("a company without a started ledger, or without accounting", () => {
  it("accounting enabled but the ledger never started: refused (ledger_not_started) with nothing written", async () => {
    const p = await product("LC-N1");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    await h.sql`update accounting.settings set ledger_starts_on = null where company_id = ${h.companyId}`;
    try {
      const before = await footprint(p, movement);
      await expect(allocate({ movementId: movement, amount: 80, basis: "value" })).rejects.toThrow(/ledger_not_started/);
      expect(await footprint(p, movement)).toEqual(before);
    } finally {
      await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
    }
  });

  it("accounting switched off (enabled, then disabled): the allocation succeeds, nothing is written into accounting, the event parks", async () => {
    const p = await product("LC-N2");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    await setAccounting(true);
    await setAccounting(false);
    try {
      const entriesBefore = Number((await h.sql`select count(*)::int as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n);
      const landed = await allocate({ movementId: movement, amount: 80, basis: "value" });
      expect(landed.status).toBe("posted");
      expect(await layerOf(h, p, w.id)).toEqual({ qty: 5, value: 280, avgCost: 56 });
      const row = await eventOf("costing.landed_cost.allocated", landed.id);
      expect(await handledByAccounting(row.id)).toBe(false);
      expect(Number((await h.sql`select count(*)::int as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n)).toBe(entriesBefore);

      // Accounting is enabled later: the consumer posts the parked event.
      await setAccounting(true);
      await h.deliver(row, "accounting");
      expect(await entriesOf(row.id)).toHaveLength(1);
      expect(await failuresCount()).toBe(0);
    } finally {
      await setAccounting(true);
    }
  });

  it("voided while its event is parked: the event is dismissed and never reaches the ledger when accounting is enabled", async () => {
    const p = await product("LC-N3");
    const movement = await receipt([{ productId: p, qty: 5, unitCost: 40 }]);
    await setAccounting(false);
    try {
      const landed = await allocate({ movementId: movement, amount: 80, basis: "value" });
      const allocated = await eventOf("costing.landed_cost.allocated", landed.id);
      expect(await handledByAccounting(allocated.id)).toBe(false);
      await h.runStepUp(h.admin, "costing.landed_cost.void", { id: landed.id, reason: "Mal cargado", date: date() });
      expect(await layerOf(h, p, w.id)).toEqual({ qty: 5, value: 200, avgCost: 40 });
      expect(await handledByAccounting(allocated.id)).toBe(true);
      const voided = await eventOf("costing.landed_cost.voided", landed.id);
      await setAccounting(true);
      await h.deliver(allocated, "accounting");
      await h.deliver(voided, "accounting");
      expect(await entriesOfSource(landed.id)).toEqual([]);
      expect(await failuresCount()).toBe(0);
    } finally {
      await setAccounting(true);
    }
  });
});

describe("costing settings", () => {
  it("accepts average, creates the row once, and refuses fifo with the phase 3 text", async () => {
    const first = await h.runStepUp<{ id: string; method: string }>(h.admin, "costing.settings.update", { method: "average" });
    const second = await h.runStepUp<{ id: string }>(h.admin, "costing.settings.update", { method: "average" });
    expect(second.id).toBe(first.id);
    await expect(h.runStepUp(h.admin, "costing.settings.update", { method: "fifo" })).rejects.toThrow(/disponible en la fase 3/);
    expect(await h.sql`select method from costing.settings where company_id = ${h.companyId}`).toEqual([{ method: "average" }]);
    expect(await h.run(h.admin, "costing.settings.consult", {})).toMatchObject({ configured: true, method: "average" });
  });

  it("the database only holds average today", async () => {
    await expect(h.sql`update costing.settings set method = 'fifo' where company_id = ${h.companyId}`).rejects.toThrow();
  });
});
