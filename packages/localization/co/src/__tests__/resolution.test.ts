import { describe, expect, it } from "vitest";
import { ResolutionError, isResolution, isResolutionData, nextInvoiceNumber, type Resolution } from "../einvoice/resolution";

const resolution: Resolution = {
  number: "18760000001", prefix: "SETP", from: 990000000, to: 990000010,
  validFrom: "2026-01-01", validTo: "2027-12-31", technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c",
};

/** A fake transaction: one tagged-template call returns what the SQL function would. */
function fakeTx(result: unknown) {
  const calls: unknown[][] = [];
  const tx = (async (_s: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return [{ result }];
  }) as never;
  return { tx, calls };
}

describe("isResolution", () => {
  it("accepts the full shape and rejects missing or inverted fields", () => {
    expect(isResolution(resolution)).toBe(true);
    expect(isResolution({ ...resolution, to: 5 })).toBe(false);
    expect(isResolution({ ...resolution, technicalKey: undefined })).toBe(false);
    // A refusal answers the resolution without its key (stored apart since migration 0104).
    expect(isResolutionData({ ...resolution, technicalKey: undefined })).toBe(true);
    expect(isResolutionData({ ...resolution, to: 5 })).toBe(false);
    expect(isResolution({ ...resolution, validTo: "2025-01-01" })).toBe(false);
    expect(isResolution({ ...resolution, validFrom: "2026-02-30" })).toBe(false);
    expect(isResolution({ ...resolution, validTo: "2026-13-01" })).toBe(false);
    expect(isResolution({ ...resolution, to: 1e19 })).toBe(false);
    expect(isResolution({ ...resolution, to: 2 ** 53 })).toBe(false);
  });
});

describe("nextInvoiceNumber", () => {
  it("returns prefix, number and the full text", async () => {
    const { tx, calls } = fakeTx({ status: "ok", prefix: "SETP", number: 990000003 });
    const r = await nextInvoiceNumber(tx, "co-1", "invoice", "2026-05-01");
    expect(r).toEqual({ prefix: "SETP", number: 990000003, full: "SETP990000003" });
    expect(calls[0]).toEqual(["co-1", "invoice", "2026-05-01"]);
  });
  it("refuses past the range end with the resolution data", async () => {
    const { tx } = fakeTx({ status: "out_of_range", resolution });
    await expect(nextInvoiceNumber(tx, "co-1", "invoice", "2026-05-01")).rejects.toMatchObject({ code: "out_of_range", resolution });
  });
  it("refuses after the validity end", async () => {
    const { tx } = fakeTx({ status: "expired", resolution });
    const err = await nextInvoiceNumber(tx, "co-1", "credit_note", "2028-01-01").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err).toMatchObject({ code: "expired", resolution });
  });
  it("refuses when the company has no resolution for the type", async () => {
    const { tx } = fakeTx({ status: "no_resolution" });
    await expect(nextInvoiceNumber(tx, "co-1", "debit_note", "2026-05-01")).rejects.toMatchObject({ code: "no_resolution" });
  });
});
