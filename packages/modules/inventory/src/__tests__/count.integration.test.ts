import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inventoryHarness, product, stockOf, warehouse, type InventoryHarness } from "./helpers";

// inventory.count.create / record / apply (plan 2B Task 7): a conteo físico lists what to count, record stores what was counted next to
// what the system held at that moment, and apply (step-up) posts the differences (counted − system) as exactly ONE adjustment.

type Created = { id: string; number: string | null; status: string; lines: { id: string; productId: string }[] };
type Applied = { id: string; stage: string; adjustmentId: string | null; adjustmentNumber: string | null };

describe("inventory counts", () => {
  let h: InventoryHarness;
  beforeAll(async () => {
    h = await inventoryHarness();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const today = "2026-11-04";
  const receipt = (warehouseId: string, locationId: string, productId: string, qty: number) =>
    h.run(h.admin, "inventory.movement.post", { kind: "receipt", date: today, warehouseId, lines: [{ productId, locationId, qty }] });
  const create = (warehouseId: string, lines: Record<string, unknown>[]) => h.run<Created>(h.admin, "inventory.count.create", { date: today, warehouseId, lines });
  const record = (id: string, counted: { lineId: string; countedQty: number }[]) => h.run(h.admin, "inventory.count.record", { id, lines: counted });
  const apply = (id: string) => h.runStepUp<Applied>(h.admin, "inventory.count.apply", { id });

  it("creates a numbered open conteo whose lines are not counted yet", async () => {
    const productId = await product(h, h.admin, "CT-1");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "CW1");
    await receipt(warehouseId, locationId, productId, 10);
    const c = await create(warehouseId, [{ productId, locationId }]);
    expect(c.number).toMatch(/^CT-\d+$/);
    expect(c).toMatchObject({ status: "saved" });
    const [row] = await h.sql`select stage, status, posts, adjustment_id from inventory.counts where id = ${c.id}`;
    expect(row).toMatchObject({ stage: "open", status: "saved", posts: false, adjustment_id: null });
    const lines = await h.sql`select counted_qty, system_qty, difference from inventory.count_lines where count_id = ${c.id}`;
    expect(lines).toEqual([{ counted_qty: null, system_qty: null, difference: null }]);
  });

  it("record stores counted, system and difference; apply posts ONE adjustment with the right signs and moves the stock", async () => {
    const [p1, p2, p3] = [await product(h, h.admin, "CT-2A"), await product(h, h.admin, "CT-2B"), await product(h, h.admin, "CT-2C")];
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "CW2");
    for (const [p, q] of [[p1, 10], [p2, 8], [p3, 5]] as const) await receipt(warehouseId, locationId, p, q);
    const c = await create(warehouseId, [{ productId: p1, locationId }, { productId: p2, locationId }, { productId: p3, locationId }]);
    const lineOf = (productId: string) => c.lines.find((l) => l.productId === productId)!.id;
    // p1: 7 counted of 10 (−3); p2: 11 of 8 (+3); p3: 5 of 5 (no difference).
    await record(c.id, [{ lineId: lineOf(p1), countedQty: 7 }, { lineId: lineOf(p2), countedQty: 11 }, { lineId: lineOf(p3), countedQty: 5 }]);
    const lines = await h.sql<{ product_id: string; system_qty: string; counted_qty: string; difference: string }[]>`select product_id, system_qty, counted_qty, difference from inventory.count_lines where count_id = ${c.id}`;
    const byProduct = Object.fromEntries(lines.map((l) => [l.product_id, [Number(l.system_qty), Number(l.counted_qty), Number(l.difference)]]));
    expect(byProduct).toEqual({ [p1]: [10, 7, -3], [p2]: [8, 11, 3], [p3]: [5, 5, 0] });
    // Nothing moved by recording.
    expect(await stockOf(h, p1, warehouseId)).toMatchObject({ onHand: 10 });

    const applied = await apply(c.id);
    expect(applied).toMatchObject({ id: c.id, stage: "applied" });
    expect(applied.adjustmentNumber).toMatch(/^AJ-\d+$/);
    expect(await stockOf(h, p1, warehouseId)).toMatchObject({ onHand: 7 });
    expect(await stockOf(h, p2, warehouseId)).toMatchObject({ onHand: 11 });
    expect(await stockOf(h, p3, warehouseId)).toMatchObject({ onHand: 5 });

    const adjustments = await h.sql<{ id: string; kind: string; source_entity: string; source_id: string }[]>`
      select id, kind, source_entity, source_id from inventory.movements where source_id = ${c.id}`;
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({ id: applied.adjustmentId, kind: "adjustment", source_entity: "inventory.count" });
    const moved = await h.sql<{ product_id: string; qty: string }[]>`select product_id, qty from inventory.movement_lines where movement_id = ${applied.adjustmentId}`;
    expect(Object.fromEntries(moved.map((l) => [l.product_id, Number(l.qty)]))).toEqual({ [p1]: -3, [p2]: 3 });
    const [row] = await h.sql`select stage, applied_at is not null as applied, adjustment_id from inventory.counts where id = ${c.id}`;
    expect(row).toMatchObject({ stage: "applied", applied: true, adjustment_id: applied.adjustmentId });
    const events = await h.sql<{ payload: { kind: string; value: number } }[]>`
      select payload from kernel.outbox where company_id = ${h.companyId} and event = 'inventory.movement.posted' and payload->>'movementId' = ${applied.adjustmentId!}`;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ kind: "adjustment", sourceEntity: "inventory.count" });
  });

  it("re-applying is refused (one adjustment only), recording after apply is refused, and apply needs step-up", async () => {
    const productId = await product(h, h.admin, "CT-3");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "CW3");
    await receipt(warehouseId, locationId, productId, 4);
    const c = await create(warehouseId, [{ productId, locationId }]);
    await record(c.id, [{ lineId: c.lines[0]!.id, countedQty: 6 }]);
    await expect(h.run(h.admin, "inventory.count.apply", { id: c.id })).rejects.toMatchObject({ code: "step_up_required" });
    const first = await apply(c.id);
    await expect(apply(c.id)).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^count_already_applied:/) });
    await expect(record(c.id, [{ lineId: c.lines[0]!.id, countedQty: 1 }])).rejects.toMatchObject({ message: expect.stringMatching(/^count_already_applied:/) });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 6 });
    expect((await h.sql`select 1 from inventory.movements where source_id = ${c.id}`).length).toBe(1);
    expect(first.adjustmentId).not.toBeNull();
  });

  it("apply refuses another user's step-up token (rule 15: bound to the verifying user) and a missing one", async () => {
    const productId = await product(h, h.admin, "CT-8");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "CW8");
    await receipt(warehouseId, locationId, productId, 4);
    const c = await create(warehouseId, [{ productId, locationId }]);
    await record(c.id, [{ lineId: c.lines[0]!.id, countedQty: 3 }]);
    const foreign = "foreign-" + c.id;
    await h.sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${h.seed.users.contador!}, ${h.companyId}, ${foreign})`;
    await expect(h.run({ ...h.admin, stepUpToken: foreign }, "inventory.count.apply", { id: c.id })).rejects.toMatchObject({ code: "step_up_required" });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 4 });
    await apply(c.id);
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 3 });
  });

  it("two concurrent applies post one adjustment", async () => {
    const productId = await product(h, h.admin, "CT-4");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "CW4");
    await receipt(warehouseId, locationId, productId, 10);
    const c = await create(warehouseId, [{ productId, locationId }]);
    await record(c.id, [{ lineId: c.lines[0]!.id, countedQty: 9 }]);
    const results = await Promise.allSettled([apply(c.id), apply(c.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 9 });
    expect((await h.sql`select 1 from inventory.movements where source_id = ${c.id}`).length).toBe(1);
  });

  it("apply refuses a count with lines not counted yet; a count without differences applies with no adjustment", async () => {
    const [p1, p2] = [await product(h, h.admin, "CT-5A"), await product(h, h.admin, "CT-5B")];
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "CW5");
    await receipt(warehouseId, locationId, p1, 3);
    await receipt(warehouseId, locationId, p2, 3);
    const c = await create(warehouseId, [{ productId: p1, locationId }, { productId: p2, locationId }]);
    await record(c.id, [{ lineId: c.lines[0]!.id, countedQty: 3 }]);
    await expect(apply(c.id)).rejects.toMatchObject({ message: expect.stringMatching(/^count_incomplete:/) });
    await record(c.id, [{ lineId: c.lines[1]!.id, countedQty: 3 }]);
    const applied = await apply(c.id);
    expect(applied).toMatchObject({ stage: "applied", adjustmentId: null, adjustmentNumber: null });
    expect((await h.sql`select 1 from inventory.movements where source_id = ${c.id}`).length).toBe(0);
  });

  it("the difference is counted − system at record time: later movements are not undone", async () => {
    const productId = await product(h, h.admin, "CT-6");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "CW6");
    await receipt(warehouseId, locationId, productId, 10);
    const c = await create(warehouseId, [{ productId, locationId }]);
    await record(c.id, [{ lineId: c.lines[0]!.id, countedQty: 8 }]);
    await receipt(warehouseId, locationId, productId, 5);
    await apply(c.id);
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 13 });
  });

  it("refuses duplicate bucket lines, services, an unknown line and a negative count; a service-free open count can be voided, an applied one not", async () => {
    const productId = await product(h, h.admin, "CT-7");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "CW7");
    await expect(create(warehouseId, [{ productId, locationId }, { productId, locationId }])).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_count:/) });
    const service = await product(h, h.admin, "CT-7S", { kind: "service", trackStock: false });
    await expect(create(warehouseId, [{ productId: service }])).rejects.toMatchObject({ message: expect.stringMatching(/^service_product_refused:/) });
    const c = await create(warehouseId, [{ productId, locationId }]);
    await expect(record(c.id, [{ lineId: "0192b4c0-0000-7000-8000-00000000f999", countedQty: 1 }])).rejects.toMatchObject({ message: expect.stringMatching(/^invalid_count:/) });
    await expect(record(c.id, [{ lineId: c.lines[0]!.id, countedQty: -1 }])).rejects.toMatchObject({ code: "invalid_input" });
    await h.run(h.admin, "inventory.count.void", { id: c.id, reason: "Se cancela el conteo" });
    expect((await h.sql`select status from inventory.counts where id = ${c.id}`)[0]).toMatchObject({ status: "voided" });
    const d = await create(warehouseId, [{ productId, locationId }]);
    await record(d.id, [{ lineId: d.lines[0]!.id, countedQty: 2 }]);
    await apply(d.id);
    await expect(h.run(h.admin, "inventory.count.void", { id: d.id, reason: "x" })).rejects.toMatchObject({ message: expect.stringMatching(/^count_already_applied:/) });
  });

  // Decision: the adjustment of a count is dated the day it is applied (the stock changes then); the count's date may sit in a closed period.
  it("the adjustment is dated the day the count is applied, not the count's own date", async () => {
    const productId = await product(h, h.admin, "CT-9");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "CW9");
    await receipt(warehouseId, locationId, productId, 5);
    const c = await h.run<Created>(h.admin, "inventory.count.create", { date: "2020-01-31", warehouseId, lines: [{ productId, locationId }] });
    await record(c.id, [{ lineId: c.lines[0]!.id, countedQty: 4 }]);
    const applied = await apply(c.id);
    const [movement] = await h.sql<{ date: string; today: string }[]>`
      select m.date::text as date, (now() at time zone k.timezone)::date::text as today from inventory.movements m, kernel.companies k where m.id = ${applied.adjustmentId} and k.id = m.company_id`;
    expect(movement!.date).toBe(movement!.today);
    expect(movement!.date).not.toBe("2020-01-31");
  });
});
