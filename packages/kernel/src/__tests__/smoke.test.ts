import { describe, it, expect } from "vitest";
import { KERNEL_VERSION } from "../index";
describe("kernel package", () => {
  it("exports a version", () => expect(KERNEL_VERSION).toBe("0.1.0"));
});
