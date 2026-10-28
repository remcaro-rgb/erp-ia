import { describe, expect, it } from "vitest";
import { stripInvisible, validateCustomFields, validateCustomValue, type CustomFieldDef } from "../custom-fields";

// Custom fields (Datos adicionales, design §5.14): the pure rules, shared by the processes and the form.

const ADMIN = "00000000-0000-4000-8000-000000000001";
const SELLER = "00000000-0000-4000-8000-000000000002";
const CASHIER = "00000000-0000-4000-8000-000000000003";

const def = (over: Partial<CustomFieldDef> & Pick<CustomFieldDef, "key" | "type">): CustomFieldDef => ({
  label: over.key,
  maxLength: null,
  required: false,
  options: null,
  rolesEnter: [ADMIN, SELLER],
  rolesEdit: [ADMIN, SELLER],
  rolesView: [ADMIN, SELLER, CASHIER],
  ...over,
});

const admin = { roleIds: [ADMIN] };

describe("validateCustomFields", () => {
  it("list field with a value outside options is an error naming the field", () => {
    const defs = [def({ key: "canal", label: "Canal comercial", type: "list", options: ["Retail", "HORECA"] })];
    expect(validateCustomFields(defs, { canal: "Mayorista" }, admin).errors).toEqual(["Canal comercial: Elige un valor de la lista"]);
    expect(validateCustomFields(defs, { canal: "HORECA" }, admin)).toEqual({ errors: [], missing: [] });
  });

  it("required number field empty is missing data, not an error", () => {
    const defs = [def({ key: "dia_pago", label: "Día de pago habitual", type: "number", required: true })];
    for (const extra of [{}, { dia_pago: "" }, { dia_pago: null }, { dia_pago: "  " }]) {
      expect(validateCustomFields(defs, extra, admin)).toEqual({ errors: [], missing: ["Día de pago habitual"] });
    }
    expect(validateCustomFields(defs, { dia_pago: 0 }, admin)).toEqual({ errors: [], missing: [] });
  });

  it("checks type and length of each type as the prototype does", () => {
    const check = (d: CustomFieldDef, value: unknown) => validateCustomValue(d, value);
    expect(check(def({ key: "n", type: "number" }), "12,5")).toBeNull();
    expect(check(def({ key: "n", type: "number" }), 7)).toBeNull();
    expect(check(def({ key: "n", type: "number" }), "doce")).toBe("Debe ser un número");
    expect(check(def({ key: "n", type: "number" }), Number.NaN)).toBe("Debe ser un número");
    expect(check(def({ key: "d", type: "date" }), "2026-10-28")).toBeNull();
    expect(check(def({ key: "d", type: "date" }), "28/10/2026")).toBe("Fecha AAAA-MM-DD");
    expect(check(def({ key: "d", type: "date" }), "2026-02-30")).toBe("Fecha AAAA-MM-DD");
    expect(check(def({ key: "u", type: "url" }), "https://cafe.co")).toBeNull();
    expect(check(def({ key: "u", type: "url" }), "cafe.co")).toBe("URL con http(s)://");
    expect(check(def({ key: "e", type: "email" }), "a@b.co")).toBeNull();
    expect(check(def({ key: "e", type: "email" }), "a@b")).toBe("Correo inválido");
    expect(check(def({ key: "b", type: "bool" }), true)).toBeNull();
    expect(check(def({ key: "b", type: "bool" }), "Sí")).toBeNull();
    expect(check(def({ key: "b", type: "bool" }), "quizá")).toBe("Debe ser Sí o No");
    expect(check(def({ key: "t", type: "text", maxLength: 5 }), "123456")).toBe("Máximo 5 caracteres");
    expect(check(def({ key: "t", type: "text", maxLength: 5 }), "12345")).toBeNull();
    expect(check(def({ key: "t", type: "text" }), 42)).toBe("Debe ser texto");
    expect(check(def({ key: "t", type: "text" }), "")).toBeNull();
  });

  it("rejects a value for a key nobody defined", () => {
    expect(validateCustomFields([], { fantasma: "x" }, admin).errors).toEqual(["fantasma: dato adicional no definido"]);
  });
});

describe("validateCustomFields role rules", () => {
  const defs = [def({ key: "origen", label: "Origen del café", type: "text", rolesEnter: [ADMIN], rolesEdit: [ADMIN], rolesView: [ADMIN, SELLER] })];
  const seller = { roleIds: [SELLER] };

  it("a role that cannot enter a new value, or edit a changed one, gets an error", () => {
    expect(validateCustomFields(defs, { origen: "Huila" }, seller).errors).toEqual(["Origen del café: tu rol no puede modificar este dato"]);
    expect(validateCustomFields(defs, { origen: "Nariño" }, seller, { origen: "Huila" }).errors).toEqual(["Origen del café: tu rol no puede modificar este dato"]);
    expect(validateCustomFields(defs, {}, seller, { origen: "Huila" }).errors).toEqual(["Origen del café: tu rol no puede modificar este dato"]);
    expect(validateCustomFields(defs, { origen: "Huila" }, admin).errors).toEqual([]);
  });

  it("a value left as it was is not a modification, whoever sends it", () => {
    expect(validateCustomFields(defs, { origen: "Huila" }, seller, { origen: "Huila" })).toEqual({ errors: [], missing: [] });
    expect(validateCustomFields(defs, {}, seller, { origen: "" })).toEqual({ errors: [], missing: [] });
  });

  it("any one of the caller's roles is enough", () => {
    expect(validateCustomFields(defs, { origen: "Huila" }, { roleIds: [CASHIER, ADMIN] }).errors).toEqual([]);
  });

  it("a stored value that no longer fits the definition does not fail an update that leaves it alone", () => {
    const strict = [def({ key: "canal", label: "Canal", type: "list", options: ["Retail"] })];
    expect(validateCustomFields(strict, { canal: "HORECA" }, admin, { canal: "HORECA" })).toEqual({ errors: [], missing: [] });
    expect(validateCustomFields(strict, { canal: "Otro" }, admin, { canal: "HORECA" }).errors).toEqual(["Canal: Elige un valor de la lista"]);
  });
});

describe("stripInvisible", () => {
  const defs = [
    def({ key: "sitio_web", type: "url", rolesView: [ADMIN, SELLER, CASHIER] }),
    def({ key: "dia_pago", type: "number", rolesView: [ADMIN] }),
  ];
  const extra = { sitio_web: "https://a.co", dia_pago: "15", huerfano: "x" };

  it("a role not in roles_view does not receive the key", () => {
    expect(stripInvisible(defs, extra, { roleIds: [CASHIER] })).toEqual({ sitio_web: "https://a.co" });
    expect(stripInvisible(defs, extra, { roleIds: [ADMIN] })).toEqual({ sitio_web: "https://a.co", dia_pago: "15" });
  });

  it("keys without a definition are hidden from everybody", () => {
    expect(stripInvisible(defs, extra, { roleIds: [ADMIN, SELLER, CASHIER] })).not.toHaveProperty("huerfano");
  });

  it("does not mutate its input and tolerates a missing extra", () => {
    const copy = structuredClone(extra);
    stripInvisible(defs, extra, { roleIds: [] });
    expect(extra).toEqual(copy);
    expect(stripInvisible(defs, undefined, admin)).toEqual({});
  });
});
