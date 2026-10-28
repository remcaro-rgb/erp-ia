import { describe, expect, it } from "vitest";
import { failureText } from "./failure";

const catalogue: Record<string, string> = { "errors.forbidden": "Sin permiso", "errors.unknown": "Error" };
const has = (key: string) => key in catalogue;
const t = (key: string) => catalogue[key]!;

describe("support failure text", () => {
  it("prefers the process's first non-blank message", () => {
    expect(failureText({ code: "invalid_input", details: ["", "  ", "El ticket está cerrado"] }, has, t)).toBe("El ticket está cerrado");
  });

  it("never returns an empty text: blank or missing details fall back to the error code's message, then the generic one", () => {
    expect(failureText({ code: "forbidden", details: [""] }, has, t)).toBe("Sin permiso");
    expect(failureText({ code: "forbidden", details: [] }, has, t)).toBe("Sin permiso");
    expect(failureText({ code: "weird", details: [""] }, has, t)).toBe("Error");
  });
});
