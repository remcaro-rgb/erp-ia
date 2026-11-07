import { describe, expect, it } from "vitest";
import { documentKey, postingModeData } from "./posting-mode";

describe("postingModeData (the mode card's facts)", () => {
  it("reads the consult's mode, counts and the documentos the mode applies to", () => {
    expect(postingModeData({ postingMode: "asynchronous", pendingDocuments: 3, pendingFailures: 2 }, ["invoicing.invoice.issue", "payments.payment.receive"])).toEqual({
      mode: "asynchronous", pendingDocuments: 3, pendingFailures: 2, documents: ["invoicing_invoice_issue", "payments_payment_receive"],
    });
  });

  it("defaults to the strict mode with no counts when the consult says nothing or something unknown", () => {
    expect(postingModeData(null, [])).toEqual({ mode: "inline_strict", pendingDocuments: 0, pendingFailures: 0, documents: [] });
    expect(postingModeData({ postingMode: "later", pendingDocuments: -1, pendingFailures: "x" }, [])).toMatchObject({ mode: "inline_strict", pendingDocuments: 0, pendingFailures: 0 });
  });

  it("builds the catalogue key of a process (snake_case)", () => {
    expect(documentKey("costing.landed_cost.allocate")).toBe("costing_landed_cost_allocate");
  });
});
