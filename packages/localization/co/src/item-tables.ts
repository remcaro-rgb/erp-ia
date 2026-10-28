import uom from "../data/uom.json" with { type: "json" };

// DIAN Anexo técnico FE 1.9: tables 13.3.5 (identification scheme), 13.3.6 (UoM), 13.3.10 (reference price), 13.3.11 (IVA), 13.2.2 (other taxes).

export type ItemIdScheme = { code: "999" | "010" | "001" | "020"; name: string; kind: "own" | "gtin" | "digits"; length: number; standardCodeLabel: string };

export const ITEM_ID_SCHEMES: ItemIdScheme[] = [
  { code: "999", name: "Código propio del contribuyente", kind: "own", length: 0, standardCodeLabel: "Código estándar" },
  { code: "010", name: "GTIN / EAN (GS1)", kind: "gtin", length: 14, standardCodeLabel: "Código GTIN" },
  { code: "001", name: "UNSPSC (Colombia Compra Eficiente)", kind: "digits", length: 8, standardCodeLabel: "Código UNSPSC" },
  { code: "020", name: "Partida arancelaria", kind: "digits", length: 10, standardCodeLabel: "Partida arancelaria" },
];

export type UomCode = { code: string; name: string };

/** UN/ECE Rec. 20 codes used by DIAN table 13.3.6. Curated list; the full table is a phase 2 data load. */
export const UOM_CODES: UomCode[] = uom;

export const IVA_RATES = [
  { code: "19", name: "IVA 19 % (tarifa general)" },
  { code: "5", name: "IVA 5 %" },
  { code: "0", name: "IVA 0 % · exento" },
  { code: "EXC", name: "Excluido de IVA" },
] as const;

export const INC_RATES = [
  { code: "2", name: "INC 2 %" },
  { code: "4", name: "INC 4 %" },
  { code: "8", name: "INC 8 % (tarifa general)" },
  { code: "16", name: "INC 16 %" },
] as const;

export const OTHER_TAXES = [
  { code: "22", name: "INC bolsas plásticas" },
  { code: "32", name: "ICL · licores" },
  { code: "33", name: "INPP · plásticos de un solo uso" },
  { code: "34", name: "IBUA · bebidas azucaradas" },
  { code: "35", name: "ICUI · comestibles ultraprocesados" },
  { code: "23", name: "Impuesto al carbono" },
] as const;

export const PRICE_TYPES = [
  { code: "1", name: "Valor comercial" },
  { code: "2", name: "Valor en inventarios" },
  { code: "3", name: "Otro valor" },
] as const;

export const ITEM_LIMITS = { sku: 50, description: 300, brand: 100, model: 100 } as const;
