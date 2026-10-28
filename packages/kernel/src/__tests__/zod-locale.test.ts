import { describe, expect, it } from "vitest";
import { z } from "zod";
import "../index";

// Rule 24: validation messages reach the user in Spanish, so the kernel sets Zod's Spanish locale once, at init.
describe("zod locale", () => {
  it("reports a failing schema in Spanish", () => {
    const result = z.string().min(3).safeParse("a");
    expect(result.success).toBe(false);
    const message = result.success ? "" : result.error.issues[0]!.message;
    expect(message).toMatch(/caracteres/);
    expect(message).not.toMatch(/Too small|characters/);
  });
});
