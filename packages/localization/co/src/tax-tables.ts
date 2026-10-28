export const TAX_RESPONSIBILITIES = [
  { code: "O-13", name: "Gran contribuyente" },
  { code: "O-15", name: "Autorretenedor" },
  { code: "O-23", name: "Agente de retención IVA" },
  { code: "O-47", name: "Régimen Simple de Tributación" },
  { code: "R-99-PN", name: "No responsable · no aplica" },
] as const;

export const NOT_RESPONSIBLE = "R-99-PN";

export const TAX_SCHEMES = [
  { code: "01", name: "IVA" },
  { code: "04", name: "INC" },
  { code: "ZA", name: "IVA e INC" },
  { code: "ZZ", name: "No aplica" },
] as const;

// ISO 3166-1 alpha-2 → DIAN numeric country code (exógena). Seed of the countries used by the demo; the full table is a phase 2 data load.
export const DIAN_COUNTRY_CODES: Record<string, string> = {
  CO: "169",
  US: "249",
  MX: "493",
  EC: "239",
  PE: "589",
  PA: "580",
  ES: "245",
  CL: "211",
};
