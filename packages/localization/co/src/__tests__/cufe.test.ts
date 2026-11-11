import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeCUDE, computeCUFE, computeSoftwareSecurityCode } from "../einvoice/cufe";

// Ported from Serena src/lib/dian/__tests__/cufe.test.ts; fixtures unchanged.
const base = {
  invoiceNumber: "FE001",
  issueDate: "2026-01-01",
  issueTime: "10:00:00-05:00",
  subtotal: 50000,
  ivaAmount: 0,
  incAmount: 4000,
  icaAmount: 0,
  total: 54000,
  issuerNit: "800100200",
  customerIdNumber: "9999999",
  environment: "1" as const,
};

describe("computeCUFE", () => {
  it("returns a 96-character lowercase hex string (SHA-384)", () => {
    const result = computeCUFE({
      invoiceNumber: "SETP990000001", issueDate: "2026-04-05", issueTime: "14:30:00-05:00",
      subtotal: 100000, ivaAmount: 0, incAmount: 8000, icaAmount: 0, total: 108000,
      issuerNit: "900123456", customerIdNumber: "1234567890",
      technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c", environment: "2",
    });
    expect(result).toMatch(/^[0-9a-f]{96}$/);
  });
  it("is deterministic and changes when a field changes", () => {
    const p = { ...base, technicalKey: "abc123" };
    expect(computeCUFE(p)).toBe(computeCUFE(p));
    expect(computeCUFE({ ...p, total: 54001 })).not.toBe(computeCUFE(p));
  });
  it("follows the Anexo concatenation order (NumFac..TipoAmb with codes 01, 04, 03)", () => {
    const p = { ...base, technicalKey: "abc123" };
    const concat = "FE001" + "2026-01-01" + "10:00:00-05:00" + "50000.00" + "01" + "0.00" + "04" + "4000.00" + "03" + "0.00" + "54000.00" + "800100200" + "9999999" + "abc123" + "1";
    expect(computeCUFE(p)).toBe(createHash("sha384").update(concat, "utf8").digest("hex"));
  });
});

describe("computeCUDE", () => {
  it("returns a 96-character hex string using softwarePin", () => {
    expect(computeCUDE({ ...base, softwarePin: "12345" })).toMatch(/^[0-9a-f]{96}$/);
  });
  it("equals CUFE when the key is the same string (only the key type differs)", () => {
    expect(computeCUFE({ ...base, technicalKey: "SAMEKEY" })).toBe(computeCUDE({ ...base, softwarePin: "SAMEKEY" }));
  });
});

describe("computeSoftwareSecurityCode", () => {
  it("is SHA-384 of software id + pin + document reference, deterministic", () => {
    const a = computeSoftwareSecurityCode("software-id-uuid", "12345", "SETP990000001");
    expect(a).toMatch(/^[0-9a-f]{96}$/);
    expect(a).toBe(createHash("sha384").update("software-id-uuid12345SETP990000001").digest("hex"));
  });
});
