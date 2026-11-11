import { randomUUID } from "node:crypto";
import { withClaims } from "@erp/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pdfText } from "../../../../kernel/src/templates/__tests__/pdf-text";
import { PACK_PRINT_FIELDS, PACK_PRINT_LINE_COLUMNS } from "../print";
import { confirmedOrder, good, warehouseHarness, type Harness } from "./harness";

// Packing (plan 2B.2 Task 29.3, PG §4.3 step 6; owner item 154; migration 0172). An empaque (EMP-) is made from a confirmed alistamiento:
// its packages are edited by hand (number, weight, dimensions, and which picked lines and how much go in each), it is closed, and it
// prints the «Lista de empaque» (packages, lines, lots, weights). A package never holds more of a picked line than was picked
// (pack_exceeds_pick). Packing gates nothing: the entrega of the alistamiento is made and shipped whatever the empaque's state.

interface PackOut {
  created?: boolean;
  reason?: string;
  id: string;
  number: string | null;
  status: string;
  stage: string;
  pickId: string;
  packagesCount: number;
  totalWeightKg: number | null;
  packages: { id: string; packageNo: number; weightKg: number | null; dimensions: string | null; lines: { pickLineId: string; qty: number }[]; contents: string | null }[];
}

describe("packing (Task 29.3)", () => {
  let h: Harness;
  let locationId: string;
  let lotProduct: string;
  let plainProduct: string;
  let sku: { lot: string; plain: string };
  let order: { id: string; lineIds: string[] };
  let pickId: string;
  let pickLines: { id: string; product_id: string; qty_picked: string | null }[];
  let pack: PackOut;

  beforeAll(async () => {
    h = await warehouseHarness("860002964");
    locationId = (await h.run<{ id: string }>("inventory.location.create", { warehouseId: h.warehouseId, code: "A1", name: "Estante A1" })).id;
    sku = { lot: `LOT-${randomUUID().slice(0, 8)}`, plain: `UNT-${randomUUID().slice(0, 8)}` };
    lotProduct = (await h.run<{ id: string }>("core.product.create", good(sku.lot))).id;
    plainProduct = (await h.run<{ id: string }>("core.product.create", good(sku.plain))).id;
    await h.runStepUp("inventory.product_tracking.set", { productId: lotProduct, tracking: "lot" });
    await h.run("inventory.movement.post", { kind: "receipt", date: h.day(1, 10), warehouseId: h.warehouseId, lines: [
      { productId: lotProduct, locationId, qty: 10, unitCost: 100, lot: { code: "L-2311", expiresOn: `${h.year + 1}-12-01` } },
      { productId: plainProduct, locationId, qty: 10, unitCost: 50 },
    ] });
    expect(await h.drain()).toEqual([]);
    order = await confirmedOrder(h, [{ productId: lotProduct, qty: 4 }, { productId: plainProduct, qty: 3 }]);
    pickId = (await h.sql<{ id: string }[]>`select id from warehouse.picks where order_id = ${order.id}`)[0]!.id;
  }, 300_000);

  afterAll(async () => {
    await h.cleanup();
  });

  it("(1) migration 0172: the packs tables have company RLS, row audit and seq; an alistamiento not yet confirmed is not packed", async () => {
    const rls = await h.sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'warehouse' and c.relname = any(${["packs", "pack_packages", "putaway_rules"]}) order by c.relname`;
    expect(rls).toEqual([
      { relname: "pack_packages", relrowsecurity: true }, { relname: "packs", relrowsecurity: true }, { relname: "putaway_rules", relrowsecurity: true },
    ]);
    const audited = await h.sql<{ table: string }[]>`
      select distinct c.relname as table from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'warehouse' and t.tgname like '%audit%' and c.relname = any(${["packs", "pack_packages", "putaway_rules"]}) order by 1`;
    expect(audited.map((r) => r.table)).toEqual(["pack_packages", "packs", "putaway_rules"]);
    const early = await h.refusal(h.run("warehouse.pack.create", { pickId }));
    expect(early?.message).toMatch(/^pick_not_confirmed/);
  });

  it("(2) an empaque of a confirmed alistamiento starts with one package holding everything picked; a second create answers it", async () => {
    await h.run("warehouse.pick.confirm", { id: pickId });
    expect(await h.drain()).toEqual([]);
    pickLines = await h.sql`select id, product_id, qty_picked::text from warehouse.pick_lines where pick_id = ${pickId} order by line_no`;
    expect(pickLines.map((l) => [l.product_id, Number(l.qty_picked)])).toEqual([[lotProduct, 4], [plainProduct, 3]]);

    pack = await h.run<PackOut>("warehouse.pack.create", { pickId });
    expect(pack).toMatchObject({ created: true, number: "EMP-1", status: "saved", stage: "open", pickId, packagesCount: 1 });
    expect(pack.packages.map((p) => [p.packageNo, p.lines])).toEqual([[1, pickLines.map((l) => ({ pickLineId: l.id, qty: Number(l.qty_picked) }))]]);
    const [row] = await h.sql<{ seq: string; order_id: string; warehouse_id: string; party_id: string }[]>`select seq::text, order_id, warehouse_id, party_id from warehouse.packs where id = ${pack.id}`;
    expect(Number(row!.seq)).toBeGreaterThan(0);
    expect(row).toMatchObject({ order_id: order.id, warehouse_id: h.warehouseId, party_id: h.partyId });
    expect(await h.sql`select 1 from kernel.audit_log where company_id = ${h.companyId} and entity = 'warehouse.packs' and row_id = ${pack.id} and action = 'insert'`).toHaveLength(1);
    expect(await h.run<PackOut>("warehouse.pack.create", { pickId })).toMatchObject({ created: false, reason: "pack_exists", id: pack.id });
  });

  it("(3) two packages by hand: weights, dimensions and contents; packing more of a line than was picked is refused pack_exceeds_pick", async () => {
    const [lotLine, plainLine] = pickLines;
    pack = await h.run<PackOut>("warehouse.pack.update", { id: pack.id, packages: [
      { packageNo: 1, weightKg: 4.5, dimensions: "40x30x30 cm", lines: [{ pickLineId: lotLine!.id, qty: 2 }, { pickLineId: plainLine!.id, qty: 3 }] },
      { packageNo: 2, weightKg: 2.25, lines: [{ pickLineId: lotLine!.id, qty: 2 }] },
    ] });
    expect(pack).toMatchObject({ packagesCount: 2, totalWeightKg: 6.75 });
    expect(pack.packages.map((p) => [p.packageNo, p.weightKg, p.dimensions])).toEqual([[1, 4.5, "40x30x30 cm"], [2, 2.25, null]]);
    expect(pack.packages[0]!.contents).toContain(sku.lot);
    expect(pack.packages[0]!.contents).toContain("L-2311");
    expect(pack.packages[0]!.contents).toContain(sku.plain);

    const over = await h.refusal(h.run("warehouse.pack.update", { id: pack.id, packages: [
      { packageNo: 1, lines: [{ pickLineId: lotLine!.id, qty: 3 }] },
      { packageNo: 2, lines: [{ pickLineId: lotLine!.id, qty: 2 }] },
    ] }));
    expect(over).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^pack_exceeds_pick/) });
    expect(JSON.stringify(over!.details)).toContain("5");
    // Nothing changed.
    expect((await h.run<PackOut>("warehouse.pack.consult", { id: pack.id })).packagesCount).toBe(2);
    // A package number twice, or a line of another alistamiento, is refused too.
    expect((await h.refusal(h.run("warehouse.pack.update", { id: pack.id, packages: [{ packageNo: 1, lines: [] }, { packageNo: 1, lines: [] }] })))?.message).toMatch(/^duplicate_package/);
    expect((await h.refusal(h.run("warehouse.pack.update", { id: pack.id, packages: [{ packageNo: 1, lines: [{ pickLineId: randomUUID(), qty: 1 }] }] })))?.message).toMatch(/^invalid_pick_line/);
  });

  it("(4) the «Lista de empaque» prints the packages, their lines and lots, and the weights", async () => {
    expect(PACK_PRINT_FIELDS).toEqual(expect.arrayContaining(["number", "pick_id", "order_id", "party_id", "packages_count", "total_weight_kg"]));
    expect(PACK_PRINT_LINE_COLUMNS).toEqual(["package_no", "contents", "weight_kg", "dimensions"]);
    const { fileId } = await h.run<{ fileId: string }>("kernel.doc_template.print", { entity: "warehouse.pack", recordId: pack.id });
    const [job] = await h.sql<{ storage_path: string }[]>`select storage_path from kernel.export_jobs where id = ${fileId}`;
    const text = pdfText(await h.exportsStore.get(job!.storage_path));
    // The title «Lista de empaque» comes from the caller's catalogue (entities.test.ts); a print without one keeps the record's number.
    expect(text).toContain("EMP-1");
    expect(text).toContain(sku.lot);
    expect(text).toContain(sku.plain);
    expect(text).toContain("L-2311");
    expect(text).toContain("40x30x30 cm");
    expect(text).toMatch(/4,5/);
  });

  it("(5) closing locks the packages; packing gates nothing: the entrega of the alistamiento ships while the empaque is open or closed", async () => {
    const closed = await h.run<PackOut>("warehouse.pack.close", { id: pack.id });
    expect(closed.stage).toBe("closed");
    expect((await h.refusal(h.run("warehouse.pack.update", { id: pack.id, packages: [{ packageNo: 1, lines: [] }] })))?.message).toMatch(/^pack_closed/);
    // The entrega made from the alistamiento (delivery_from_pick, Task 29.2) ships as it would without an empaque.
    const [delivery] = await h.sql<{ id: string }[]>`select id from sales.deliveries where order_id = ${order.id} and status <> 'voided'`;
    await h.run("sales.delivery.ship", { id: delivery!.id });
    expect(await h.drain()).toEqual([]);
    const [shipped] = await h.sql<{ stage: string }[]>`select stage from sales.deliveries where id = ${delivery!.id}`;
    expect(shipped!.stage).not.toBe("open");
    // Anular: the empaque goes, the entrega stays.
    const voided = await h.run<PackOut>("warehouse.pack.void", { id: pack.id, reason: "Se reempacó" });
    expect(voided.status).toBe("voided");
    expect(await h.sql`select 1 from sales.deliveries where id = ${delivery!.id} and status <> 'voided'`).toHaveLength(1);
    // Read as the caller: the masked views list the empaque and its packages.
    const seen = await withClaims(h.sql, h.admin.claims, (tx) => tx<{ id: string }[]>`select id from warehouse.v_pack_packages where pack_id = ${pack.id}`);
    expect(seen).toHaveLength(2);
  });
});
