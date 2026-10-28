import { describe, expect, it } from "vitest";
import { extraChanges } from "./extra-patch";

// What the Datos adicionales tab sends on Guardar: only the keys the user changed, so a form loaded earlier cannot
// overwrite what somebody else saved meanwhile; a removed key travels as null.

describe("extraChanges", () => {
  const base = { extra: { canal: "Retail", dia_pago: "15" }, extraFree: [{ name: "Ruta", value: "Norte" }] };

  it("sends the changed keys only, null for a removed one, and nothing for what did not change", () => {
    expect(extraChanges(base, { ...base, extra: { canal: "HORECA", dia_pago: "15" } })).toEqual({ extraPatch: { canal: "HORECA" } });
    expect(extraChanges(base, { ...base, extra: { canal: "Retail" } })).toEqual({ extraPatch: { dia_pago: null } });
    expect(extraChanges(base, { ...base, extra: { canal: "Retail", dia_pago: "15", origen: "Huila" } })).toEqual({ extraPatch: { origen: "Huila" } });
    expect(extraChanges(base, base)).toEqual({});
  });

  it("sends the free pairs as a whole, and only when they changed", () => {
    expect(extraChanges(base, { ...base, extraFree: [] })).toEqual({ extraFree: [] });
    expect(extraChanges(base, { ...base, extraFree: [{ name: "Ruta", value: "Sur" }] })).toEqual({ extraFree: [{ name: "Ruta", value: "Sur" }] });
  });

  it("compares values by content: a number is not its text", () => {
    expect(extraChanges({ extra: { n: 1 }, extraFree: [] }, { extra: { n: "1" }, extraFree: [] })).toEqual({ extraPatch: { n: "1" } });
    expect(extraChanges({ extra: { b: true }, extraFree: [] }, { extra: { b: true }, extraFree: [] })).toEqual({});
  });
});
