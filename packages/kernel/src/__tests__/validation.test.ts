import { describe, it, expect } from "vitest";
import { DEFAULT_PHONE_CC, validateEmail, validatePhone } from "../validation";

describe("validateEmail", () => {
  it("accepts a valid address and explains an invalid one", () => {
    expect(validateEmail("fe@exito.com")).toBeNull();
    expect(validateEmail("no-es-correo")).toBe("Correo inválido (nombre@dominio.ext)");
    expect(validateEmail("mal@")).toBe("Correo inválido (nombre@dominio.ext)");
    expect(validateEmail("a@b.c")).toBe("Correo inválido (nombre@dominio.ext)");
    expect(validateEmail(`${"a".repeat(96)}@x.co`)).toBe("Máximo 100 caracteres");
  });
});

describe("validatePhone (rule 11)", () => {
  it("+57: 10 digits starting with 3 (celular) or 60 (fijo), or 7 digits", () => {
    expect(DEFAULT_PHONE_CC).toBe("57");
    expect(validatePhone("57", "3001234567")).toBeNull();
    expect(validatePhone("57", "6015550000")).toBeNull();
    expect(validatePhone("57", "5551234")).toBeNull();
    const colombia = "Colombia: celular 10 dígitos (3…) o fijo 10 dígitos (60…)";
    expect(validatePhone("57", "12345678")).toBe(colombia);
    expect(validatePhone("57", "2105558899")).toBe(colombia);
    expect(validatePhone("57", "12")).toBe(colombia);
    expect(validatePhone("+57", "3001234567")).toBeNull();
  });

  it("other calling codes: 6 to 14 digits", () => {
    expect(validatePhone("34", "915551234")).toBeNull();
    expect(validatePhone("34", "12345")).toBe("6 a 14 dígitos");
    expect(validatePhone("1", "1".repeat(15))).toBe("6 a 14 dígitos");
  });

  it("digits only, and the calling code is 1 to 3 digits", () => {
    expect(validatePhone("57", "310 555 8899")).toBe("Solo dígitos, sin espacios ni guiones");
    expect(validatePhone("57", "310-5558899")).toBe("Solo dígitos, sin espacios ni guiones");
    expect(validatePhone("5x", "3001234567")).toBe("Indicativo de país: 1 a 3 dígitos");
    expect(validatePhone("1234", "3001234567")).toBe("Indicativo de país: 1 a 3 dígitos");
  });
});
