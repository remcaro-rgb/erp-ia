import { describe, expect, it } from "vitest";
import { processName } from "./names";

describe("processName", () => {
  it("takes the description up to the first colon or semicolon", () => {
    expect(processName("crm.lead.convert", "Convierte un prospecto en cliente: crea el tercero")).toBe("Convierte un prospecto en cliente");
    expect(processName("x.y", "Primera parte; segunda")).toBe("Primera parte");
  });
  it("cuts a long description at 80 characters", () => {
    const name = processName("x.y", "a".repeat(200));
    expect(name).toHaveLength(78);
    expect(name.endsWith("…")).toBe(true);
  });
  it("falls back to the id when the registry has no description", () => {
    expect(processName("x.y", undefined)).toBe("x.y");
    expect(processName("x.y", "  ")).toBe("x.y");
  });
});
