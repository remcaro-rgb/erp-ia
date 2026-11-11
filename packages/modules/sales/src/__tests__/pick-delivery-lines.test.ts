import { describe, expect, it } from "vitest";
import { deliveryLinesFromPick } from "../processes/delivery";

// The entrega lines of an allocated alistamiento (plan 2B.2 Task 29.2): one per pedido line, the lot when the line was picked from one lot,
// the serials of a serial product; a line picked from two lots names none (the ship takes the allocations first).
describe("deliveryLinesFromPick", () => {
  const a = "00000000-0000-7000-8000-00000000000a";
  const b = "00000000-0000-7000-8000-00000000000b";
  const c = "00000000-0000-7000-8000-00000000000c";
  it("sums each pedido line, keeps one lot, lists the serials and names no lot for a split over two lots", () => {
    expect(deliveryLinesFromPick([
      { orderLineId: a, lotId: "lot-1", qty: 2 },
      { orderLineId: a, lotId: "lot-1", qty: 1 },
      { orderLineId: b, lotId: null, serialId: "s-1", qty: 1 },
      { orderLineId: b, lotId: null, serialId: "s-2", qty: 1 },
      { orderLineId: c, lotId: "lot-1", qty: 1.5 },
      { orderLineId: c, lotId: "lot-2", qty: 2 },
    ])).toEqual([
      { orderLineId: a, qty: 3, lotId: "lot-1" },
      { orderLineId: b, qty: 2, serialIds: ["s-1", "s-2"] },
      { orderLineId: c, qty: 3.5 },
    ]);
  });
  it("an untracked line carries only its quantity", () => {
    expect(deliveryLinesFromPick([{ orderLineId: a, qty: 4 }, { orderLineId: a, lotId: null, serialId: null, qty: 2 }])).toEqual([{ orderLineId: a, qty: 6 }]);
  });
});
