import { describe, expect, it } from "vitest";
import { untitledRecordTitle } from "./record-title";

// Task 17 round 1, D16: an untitled comprobante is «Borrador» only in Borrador; past it, without a number, it shows its ID.
const base = { isEntry: true, draftTitle: "Borrador", idLabel: "ID", fallback: "uuid" };

describe("untitledRecordTitle", () => {
  it("a draft comprobante is «Borrador»", () => expect(untitledRecordTitle({ ...base, status: "draft", seq: 52 })).toBe("Borrador"));
  it("a pending comprobante without number shows its ID", () => expect(untitledRecordTitle({ ...base, status: "pending", seq: 52 })).toBe("ID 52"));
  it("any other untitled typed record shows its ID, else the uuid", () => {
    expect(untitledRecordTitle({ ...base, isEntry: false, status: "saved", seq: "7" })).toBe("ID 7");
    expect(untitledRecordTitle({ ...base, isEntry: false, status: undefined, seq: null })).toBe("uuid");
  });
});
