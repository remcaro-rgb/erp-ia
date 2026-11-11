import { describe, expect, it } from "vitest";
import { instancesOf } from "../processes/einvoice";

// The lots and serials an invoice line froze, as the electronic document's cac:ItemInstance (Task 28.4 review): a lot with its expiry, a
// serial, or a serial that sits in a lot (SerialID and LotIdentification together, as the pack's XML helper writes them).

describe("instancesOf", () => {
  it("a lot keeps its expiry, a serial its number, a serial in a lot both", () => {
    expect(instancesOf([
      { lotCode: "L-1", expiresOn: "2027-01-31", serialNo: null, qty: 2 },
      { lotCode: null, expiresOn: null, serialNo: "S-1", qty: 1 },
      { lotCode: "L-9", expiresOn: "2027-03-15", serialNo: "S-2", qty: 1 },
    ])).toEqual([
      { lotNumber: "L-1", expiryDate: "2027-01-31" },
      { serialId: "S-1" },
      { serialId: "S-2", lotNumber: "L-9", expiryDate: "2027-03-15" },
    ]);
    expect(instancesOf(null)).toEqual([]);
  });
});
