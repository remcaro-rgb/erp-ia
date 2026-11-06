import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inventoryHarness, product, stockOf, warehouse, type InventoryHarness } from "./helpers";

// inventory.adjustment.post (plan 2B Task 7, rule 15): a sensitive process (fresh TOTP step-up, bound to the user, 5 minutes) that
// needs a reason, moves the stock with kind `adjustment` and emits inventory.movement.posted carrying the value the 2A rule posts.
// The ledger side (the engine over the demo chart) is tested in accounting: inventory-adjustment.integration.test.ts.

type Posted = { id: string | null; number: string | null; status: string; skippedLines: number };

describe("inventory.adjustment.post", () => {
  let h: InventoryHarness;
  beforeAll(async () => {
    h = await inventoryHarness();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const today = "2026-11-04";
  const input = (warehouseId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ date: today, warehouseId, reason: "Merma por humedad", lines, ...extra });
  const eventOf = async (movementId: string) =>
    (await h.sql<{ payload: { kind: string; value: number; costMissing?: boolean; lines: { qty: number; unitCost: number | null; value: number }[] } }[]>`
      select payload from kernel.outbox where company_id = ${h.companyId} and event = 'inventory.movement.posted' and payload->>'movementId' = ${movementId}`)[0]!.payload;

  it("is refused without a step-up verification and moves nothing", async () => {
    const productId = await product(h, h.admin, "AJ-1");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "AJW1");
    await expect(h.run(h.admin, "inventory.adjustment.post", input(warehouseId, [{ productId, locationId, qty: 5 }]))).rejects.toMatchObject({ code: "step_up_required" });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 0 });
    expect((await h.sql`select 1 from inventory.movements where warehouse_id = ${warehouseId}`).length).toBe(0);
  });

  it("is refused with a step-up of another user, an old one (> 5 minutes) or one already used", async () => {
    const productId = await product(h, h.admin, "AJ-2");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "AJW2");
    const ok = input(warehouseId, [{ productId, locationId, qty: 5 }]);
    // A verification of ANOTHER user of the same company (rule 15: bound to the verifying user).
    const foreign = randomUUID();
    await h.sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${h.seed.users.contador!}, ${h.companyId}, ${foreign})`;
    const old = randomUUID();
    await h.sql`insert into kernel.step_up_verifications(user_id, company_id, token, verified_at) values (${h.admin.claims.sub}, ${h.companyId}, ${old}, now() - interval '6 minutes')`;
    await expect(h.run({ ...h.admin, stepUpToken: foreign }, "inventory.adjustment.post", ok)).rejects.toMatchObject({ code: "step_up_required" });
    await expect(h.run({ ...h.admin, stepUpToken: old }, "inventory.adjustment.post", ok)).rejects.toMatchObject({ code: "step_up_required" });
    const used = await h.stepUp(h.admin);
    await h.run(used, "inventory.adjustment.post", ok);
    await expect(h.run(used, "inventory.adjustment.post", ok)).rejects.toMatchObject({ code: "step_up_required" });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 5 });
  });

  it("requires a reason", async () => {
    const productId = await product(h, h.admin, "AJ-3");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "AJW3");
    const lines = [{ productId, locationId, qty: 1 }];
    for (const reason of [undefined, "", "   ", "ab"]) {
      await expect(h.runStepUp(h.admin, "inventory.adjustment.post", { date: today, warehouseId, lines, ...(reason === undefined ? {} : { reason }) })).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect((await h.sql`select 1 from inventory.movements where warehouse_id = ${warehouseId}`).length).toBe(0);
  });

  it("with step-up and a reason a gain and a loss move the stock, are numbered AJ-, keep the reason and carry their value in the event", async () => {
    const productId = await product(h, h.admin, "AJ-4", { standardCost: 7000 });
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "AJW4");
    const gain = await h.runStepUp<Posted>(h.admin, "inventory.adjustment.post", input(warehouseId, [{ productId, locationId, qty: 10 }], { reason: "Sobrante en inventario inicial" }));
    expect(gain).toMatchObject({ status: "saved" });
    expect(gain.number).toMatch(/^AJ-\d+$/);
    const loss = await h.runStepUp<Posted>(h.admin, "inventory.adjustment.post", input(warehouseId, [{ productId, locationId, qty: -3, unitCost: 8000 }]));
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 7 });
    const [row] = await h.sql`select kind, description, status, posts from inventory.movements where id = ${gain.id}`;
    expect(row).toMatchObject({ kind: "adjustment", description: "Sobrante en inventario inicial", status: "saved", posts: false });
    // The standard cost values a line without cost; a line's own cost wins. Positive = gain, negative = loss.
    expect(await eventOf(gain.id!)).toMatchObject({ kind: "adjustment", value: 70000, lines: [{ qty: 10, unitCost: 7000, value: 70000 }] });
    expect(await eventOf(loss.id!)).toMatchObject({ kind: "adjustment", value: 24000, lines: [{ qty: -3, unitCost: 8000, value: -24000 }] });
  });

  it("refuses a loss beyond the stock (negative_stock_refused), a service and a zero quantity; an adjustment cannot be voided", async () => {
    const productId = await product(h, h.admin, "AJ-5");
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "AJW5");
    await expect(h.runStepUp(h.admin, "inventory.adjustment.post", input(warehouseId, [{ productId, locationId, qty: -1 }]))).rejects.toMatchObject({ message: expect.stringMatching(/^negative_stock_refused:/) });
    const service = await product(h, h.admin, "AJ-5S", { kind: "service", trackStock: false });
    await expect(h.runStepUp(h.admin, "inventory.adjustment.post", input(warehouseId, [{ productId: service, qty: 1 }]))).rejects.toMatchObject({ message: expect.stringMatching(/^service_product_refused:/) });
    await expect(h.runStepUp(h.admin, "inventory.adjustment.post", input(warehouseId, [{ productId, locationId, qty: 0 }]))).rejects.toMatchObject({ code: "invalid_input" });
    const done = await h.runStepUp<Posted>(h.admin, "inventory.adjustment.post", input(warehouseId, [{ productId, locationId, qty: 2 }]));
    await expect(h.run(h.admin, "inventory.movement.void", { id: done.id, reason: "x" })).rejects.toMatchObject({ message: expect.stringMatching(/^movement_kind_not_voidable:/) });
    expect(await stockOf(h, productId, warehouseId)).toMatchObject({ onHand: 2 });
  });

  it("a movement.post cannot register an adjustment (it has its own gate)", async () => {
    const productId = await product(h, h.admin, "AJ-6");
    const { id: warehouseId } = await warehouse(h, h.admin, "AJW6");
    await expect(h.run(h.admin, "inventory.movement.post", { kind: "adjustment", date: today, warehouseId, lines: [{ productId, qty: 1 }] })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("values an adjustment identically for a role that cannot see the standard cost and for the admin; a product without any cost flags costMissing", async () => {
    const costed = await product(h, h.admin, "AJ-7", { standardCost: 5000 });
    const bare = await product(h, h.admin, "AJ-7B", { standardCost: undefined });
    const { id: warehouseId, locationId } = await warehouse(h, h.admin, "AJW7");
    const post = (caller: typeof h.admin, productId: string) =>
      h.runStepUp<Posted>(caller, "inventory.adjustment.post", input(warehouseId, [{ productId, locationId, qty: 3 }]));
    // The member's view of the product hides the cost...
    const [seen] = await h.sql`select 1 from core.v_product_stock where id = ${costed}`;
    expect(seen).toBeDefined();
    const asAdmin = await post(h.admin, costed);
    const asMember = await post(h.member, costed);
    const a = await eventOf(asAdmin.id!);
    const m = await eventOf(asMember.id!);
    expect(a).toMatchObject({ value: 15000, lines: [{ qty: 3, unitCost: 5000, value: 15000 }] });
    expect(m).toMatchObject({ value: 15000, lines: [{ qty: 3, unitCost: 5000, value: 15000 }] });
    expect(a.costMissing).toBeUndefined();
    expect(m.costMissing).toBeUndefined();
    // ...and an uncosted product moves the stock, stores no unit cost, carries value 0 and the flag for costing's recommendation.
    const uncosted = await post(h.member, bare);
    expect(await stockOf(h, bare, warehouseId)).toMatchObject({ onHand: 3 });
    expect(await eventOf(uncosted.id!)).toMatchObject({ value: 0, costMissing: true, lines: [{ qty: 3, unitCost: null, value: 0 }] });
  });
});
