import { describe, expect, it } from "vitest";
import { clickKey, defined, isUuid, text } from "./step-helpers";

// The helpers the record screens' step actions share (sales, stock, invoicing): the click's idempotency key is a real UUID or nothing.

describe("step helpers", () => {
  it("accepts only a well-formed UUID as the click's key", () => {
    expect(clickKey("0192f0c4-7d1e-7a3b-9c2d-1e2f3a4b5c6d")).toBe("0192f0c4-7d1e-7a3b-9c2d-1e2f3a4b5c6d");
    expect(clickKey("------------------------------------")).toBeUndefined();
    expect(clickKey("0192f0c47d1e7a3b9c2d1e2f3a4b5c6d0000")).toBeUndefined();
    expect(clickKey(42)).toBeUndefined();
    expect(isUuid("0192F0C4-7D1E-7A3B-9C2D-1E2F3A4B5C6D")).toBe(true);
    expect(isUuid("nope")).toBe(false);
  });

  it("trims text and drops undefined fields", () => {
    expect(text("  x ")).toBe("x");
    expect(text("   ")).toBeUndefined();
    expect(defined({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
  });
});
