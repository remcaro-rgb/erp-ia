import { describe, expect, it } from "vitest";
import { stepResult } from "./step-result";

// What a creating step of the sales screens returns (Task 39): the document to open, or, when a converter does not own the new pedido and
// may not read it (sales.order.from_quote's trimmed result, visible false), only who it went to: nothing to open, nothing named.
describe("stepResult", () => {
  it("names the created document to open", () => {
    expect(stepResult("sales.order.from_quote", { id: "o1", number: "PED-1", status: "saved", stage: "open" })).toEqual({ created: { entity: "sales.order", id: "o1", number: "PED-1" } });
    expect(stepResult("sales.delivery.create", { id: "d1", number: null })).toEqual({ created: { entity: "sales.delivery", id: "d1", number: null } });
  });

  it("answers a trimmed from_quote result with the new owner and no document to open", () => {
    expect(stepResult("sales.order.from_quote", { id: "o1", number: "PED-2", status: "saved", stage: "open", ownerId: "u1", visible: false })).toEqual({ handedOver: { number: "PED-2", ownerId: "u1" } });
    expect(stepResult("sales.order.from_quote", { id: "o1", number: null, visible: false })).toEqual({ handedOver: { number: null, ownerId: null } });
  });

  it("answers nothing for a step that creates nothing, or a result without an id", () => {
    expect(stepResult("sales.order.confirm", { id: "o1" })).toEqual({});
    expect(stepResult("sales.order.from_quote", null)).toEqual({});
  });
});
