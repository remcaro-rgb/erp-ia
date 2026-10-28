import { describe, expect, it } from "vitest";
import { DEPARTMENTS, MUNICIPALITIES, departmentName, municipalityName } from "../dane";
import { validateParty } from "../validate-party";

const base = { personType: "1", documentType: "31", documentNumber: "900373115", legalName: "Café del Norte S.A.S.", taxResponsibilities: ["O-23"], taxScheme: "01", countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cll 1 # 2-3", invoiceEmail: "fe@cafedelnorte.co", kind: ["customer"] } as const;
const natural = { ...base, personType: "2", documentType: "13", documentNumber: "79456123", firstSurname: "Jaramillo", firstName: "Andrés", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ" } as const;
const foreignSupplier = { personType: "1", documentType: "50", documentNumber: "B12345678", legalName: "Iberia Trading S.L.", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ", countryCode: "ES", addressLine: "Calle Serrano 45, Madrid", supplierEmail: "ar@iberiatrading.es", phoneCc: "34", phone: "915551234", kind: ["supplier"] } as const;

describe("validateParty", () => {
  it("computes the DV for a NIT and reports no errors or missing data", () => {
    const r = validateParty(base);
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.normalized.checkDigit).toBe("3");
  });

  it("rejects a cédula with letters, a NIT with dots, and the reserved 222222222222", () => {
    expect(validateParty({ ...base, personType: "2", documentType: "13", documentNumber: "12AB", firstSurname: "Gómez", firstName: "Ana" }).errors).toContain("13: solo dígitos");
    expect(validateParty({ ...base, documentNumber: "900.373.115" }).errors.length).toBeGreaterThan(0);
    expect(validateParty({ ...base, documentNumber: "222222222222" }).errors[0]).toMatch(/consumidor final/);
  });

  it("composes legal name from split names for natural persons and limits each part to 60", () => {
    const r = validateParty({ ...base, personType: "2", documentType: "13", documentNumber: "79456123", firstSurname: "Jaramillo", firstName: "Andrés" });
    expect(r.normalized.legalName).toBe("Jaramillo Andrés");
    expect(validateParty({ ...base, personType: "2", documentType: "13", documentNumber: "1", firstSurname: "x".repeat(61), firstName: "A" }).errors).toContain("Primer apellido: máximo 60 caracteres");
  });

  it("composes the four name parts in apellido1 apellido2 nombre1 nombre2 order and rejects digits in names", () => {
    const r = validateParty({ ...natural, secondSurname: "Pardo", otherNames: "Felipe" });
    expect(r.normalized.legalName).toBe("Jaramillo Pardo Andrés Felipe");
    expect(validateParty({ ...natural, firstName: "Ana2" }).errors).toContain("Primer nombre: no admite dígitos");
  });

  it("R-99-PN is exclusive, foreign document types need a foreign country, municipality must belong to department", () => {
    expect(validateParty({ ...base, taxResponsibilities: ["R-99-PN", "O-23"] }).errors.length).toBe(1);
    expect(validateParty({ ...base, documentType: "50", documentNumber: "B123" }).errors[0]).toMatch(/exterior/);
    expect(validateParty({ ...base, municipalityCode: "05001" }).errors[0]).toMatch(/departamento/);
  });

  it("a jurídica that is R-99-PN alone cannot use tax scheme 01", () => {
    const r = validateParty({ ...base, taxResponsibilities: ["R-99-PN"], taxScheme: "01" });
    expect(r.errors).toEqual(["Responsable de IVA (tributo 01) contradice R-99-PN"]);
    expect(validateParty({ ...base, taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ" }).errors).toEqual([]);
  });

  it("lists missing data without blocking: customer without invoice e-mail, domestic party without municipality", () => {
    const r = validateParty({ ...base, invoiceEmail: undefined, municipalityCode: undefined });
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual(["Municipio (DANE)", "Correo para recibir facturas electrónicas"]);
  });

  it("requires a supplier e-mail for suppliers and both e-mails for a party that is both", () => {
    const supplier = { ...base, kind: ["supplier"] } as const;
    expect(validateParty(supplier).missing).toEqual(["Correo para enviar documentos al proveedor"]);
    expect(validateParty({ ...supplier, supplierEmail: "pedidos@cafedelnorte.co" }).missing).toEqual([]);
    const both = { ...base, kind: ["customer", "supplier"], invoiceEmail: undefined } as const;
    expect(validateParty(both).missing).toEqual(["Correo para recibir facturas electrónicas", "Correo para enviar documentos al proveedor"]);
    expect(validateParty({ ...base, kind: ["employee"], invoiceEmail: undefined }).missing).toEqual([]);
  });

  it("a foreign supplier with no DANE data is complete and has no municipality pending", () => {
    const r = validateParty(foreignSupplier);
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.missing).not.toContain("Municipio (DANE)");
    expect(r.normalized.checkDigit).toBeNull();
  });

  it("a foreign party's DANE codes and postal code are cleared in the normalized output, without an error; it cannot use a domestic document type", () => {
    const r = validateParty({ ...foreignSupplier, departmentCode: "11", municipalityCode: "11001", postalCode: "110111" });
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.normalized.departmentCode).toBeUndefined();
    expect(r.normalized.municipalityCode).toBeUndefined();
    expect(r.normalized.postalCode).toBeUndefined();
    expect(validateParty({ ...foreignSupplier, documentType: "31", documentNumber: "900373115" }).errors[0]).toMatch(/exterior/);
  });

  it("limits document type to the person types it allows", () => {
    expect(validateParty({ ...base, documentType: "13", documentNumber: "79456123" }).errors[0]).toMatch(/no aplica a persona jurídica/);
  });

  it("validates the NIT length and the DV is derived, never typed", () => {
    expect(validateParty({ ...base, documentNumber: "12345" }).errors).toContain("31: mínimo 6 dígitos");
    expect(validateParty({ ...base, documentNumber: "900373115-3" }).errors).toContain("31: solo dígitos");
    expect(validateParty({ ...natural, documentNumber: "1".repeat(11) }).errors).toContain("13: máximo 10 caracteres");
  });

  it("flags names, address, ciiu, postal code and department rules", () => {
    expect(validateParty({ ...base, legalName: "x".repeat(451) }).errors).toContain("Razón social: máximo 450 caracteres");
    expect(validateParty({ ...base, addressLine: "x".repeat(201) }).errors).toContain("Dirección: máximo 200 caracteres");
    expect(validateParty({ ...base, ciiu: "47" }).errors).toContain("Actividad económica CIIU: 4 dígitos");
    expect(validateParty({ ...base, postalCode: "1100" }).errors).toContain("Código postal: 6 dígitos");
    expect(validateParty({ ...base, departmentCode: "99x" }).errors.length).toBeGreaterThan(0);
    expect(validateParty({ ...base, departmentCode: undefined, municipalityCode: undefined }).missing).toEqual(["Departamento (DANE)", "Municipio (DANE)"]);
    expect(validateParty({ ...base, tradeName: "x".repeat(451) }).errors).toContain("Nombre comercial: máximo 450 caracteres");
  });

  it("lists pending identity data for an empty natural person", () => {
    const r = validateParty({ ...natural, firstSurname: undefined, firstName: "", addressLine: "", taxResponsibilities: [] });
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual(["Primer apellido", "Primer nombre", "Responsabilidad fiscal", "Dirección"]);
  });

  it("validates e-mail format and length", () => {
    expect(validateParty({ ...base, invoiceEmail: "no-es-correo" }).errors).toContain("Correo de facturas: Correo inválido (nombre@dominio.ext)");
    expect(validateParty({ ...base, invoiceEmail: `${"a".repeat(96)}@x.co` }).errors).toContain("Correo de facturas: Máximo 100 caracteres");
    expect(validateParty({ ...base, kind: ["supplier"], supplierEmail: "mal@" }).errors[0]).toMatch(/^Correo del proveedor/);
  });

  it("validates phones by country code", () => {
    const co = (phone: string, phoneCc?: string) => validateParty({ ...base, phone, phoneCc }).errors;
    expect(co("3105558899")).toEqual([]);
    expect(co("6017450000", "57")).toEqual([]);
    expect(co("7450000")).toEqual([]);
    expect(co("2105558899")).toEqual(["Teléfono: Colombia: celular 10 dígitos (3…) o fijo 10 dígitos (60…)"]);
    expect(co("310555")).toEqual(["Teléfono: Colombia: celular 10 dígitos (3…) o fijo 10 dígitos (60…)"]);
    expect(co("310 555 8899")).toEqual(["Teléfono: Solo dígitos, sin espacios ni guiones"]);
    expect(co("915551234", "34")).toEqual([]);
    expect(co("12345", "34")).toEqual(["Teléfono: 6 a 14 dígitos"]);
    expect(co("1".repeat(15), "1")).toEqual(["Teléfono: 6 a 14 dígitos"]);
    expect(validateParty({ ...base, phone: undefined, phoneCc: "57" }).errors).toEqual([]);
  });

  it("does not mutate the input and returns a trimmed normalized copy", () => {
    const input = { ...base, legalName: "  Café del Norte S.A.S.  ", invoiceEmail: " fe@cafedelnorte.co " };
    const r = validateParty(input);
    expect(input.legalName).toBe("  Café del Norte S.A.S.  ");
    expect(r.normalized.legalName).toBe("Café del Norte S.A.S.");
    expect(r.normalized.invoiceEmail).toBe("fe@cafedelnorte.co");
  });
});

describe("DANE data", () => {
  it("has all 33 departments, the full municipality table and every municipality belongs to a known department", () => {
    expect(DEPARTMENTS).toHaveLength(33);
    expect(DEPARTMENTS.map((d) => d.code)).toEqual([...DEPARTMENTS.map((d) => d.code)].sort());
    for (const d of DEPARTMENTS) expect(d.code, d.name).toMatch(/^\d{2}$/);
    expect(DEPARTMENTS.some((d) => d.code === "11" && d.name === "Bogotá D.C.")).toBe(true);
    const codes = new Set(DEPARTMENTS.map((d) => d.code));
    expect(MUNICIPALITIES.length).toBeGreaterThanOrEqual(1100);
    for (const m of MUNICIPALITIES) {
      expect(codes.has(m.departmentCode), m.code).toBe(true);
      expect(m.code.startsWith(m.departmentCode), m.code).toBe(true);
      expect(m.code).toMatch(/^\d{5}$/);
      expect(m.name.trim(), m.code).toBe(m.name);
      expect(m.name.length, m.code).toBeGreaterThan(0);
    }
    expect(new Set(MUNICIPALITIES.map((m) => m.code)).size).toBe(MUNICIPALITIES.length);
    // Every department has at least one municipality and the table is sorted by code.
    for (const d of DEPARTMENTS) expect(MUNICIPALITIES.some((m) => m.departmentCode === d.code), d.name).toBe(true);
    expect(MUNICIPALITIES.map((m) => m.code)).toEqual([...MUNICIPALITIES.map((m) => m.code)].sort());
  });

  it("knows well-known DIVIPOLA codes and rejects a municipality that is not in the table", () => {
    expect(municipalityName("11001")).toBe("Bogotá D.C.");
    expect(municipalityName("05001")).toBe("Medellín");
    expect(municipalityName("76001")).toBe("Santiago de Cali");
    expect(municipalityName("88001")).toBe("San Andrés");
    expect(departmentName("76")).toBe("Valle del Cauca");
    const r = validateParty({ ...base, departmentCode: "11", municipalityCode: "11999" });
    expect(r.errors).toEqual(["Municipio DANE inválido"]);
    expect(validateParty({ ...base, departmentCode: "05", municipalityCode: "11001" }).errors).toEqual(["El municipio no pertenece al departamento"]);
  });
});
