import type { DocumentType } from "@erp/kernel";

export type PersonType = "1" | "2";

export type DocumentTypeDef = {
  code: DocumentType;
  name: string;
  /** `num` = digits only, `alnum` = letters and digits. */
  charset: "num" | "alnum";
  maxLength: number;
  /** Person types (1 jurídica, 2 natural) the document type applies to. */
  personTypes: PersonType[];
  /** Foreign-only document types (41, 42, 50): the party must have a country other than CO. */
  foreign: boolean;
};

// DIAN document types (Anexo técnico FE 1.9, design §5.8a). Numeric ones max 10 digits (PEP/PPT 15); foreign ones alphanumeric max 20.
export const DOCUMENT_TYPES: Record<DocumentType, DocumentTypeDef> = {
  "11": { code: "11", name: "Registro civil", charset: "num", maxLength: 10, personTypes: ["2"], foreign: false },
  "12": { code: "12", name: "Tarjeta de identidad", charset: "num", maxLength: 10, personTypes: ["2"], foreign: false },
  "13": { code: "13", name: "Cédula de ciudadanía", charset: "num", maxLength: 10, personTypes: ["2"], foreign: false },
  "21": { code: "21", name: "Tarjeta de extranjería", charset: "num", maxLength: 10, personTypes: ["2"], foreign: false },
  "22": { code: "22", name: "Cédula de extranjería", charset: "num", maxLength: 10, personTypes: ["2"], foreign: false },
  "31": { code: "31", name: "NIT", charset: "num", maxLength: 10, personTypes: ["1", "2"], foreign: false },
  "41": { code: "41", name: "Pasaporte", charset: "alnum", maxLength: 20, personTypes: ["2"], foreign: true },
  "42": { code: "42", name: "Documento de identificación extranjero", charset: "alnum", maxLength: 20, personTypes: ["1", "2"], foreign: true },
  "47": { code: "47", name: "PEP · Permiso especial de permanencia", charset: "num", maxLength: 15, personTypes: ["2"], foreign: false },
  "48": { code: "48", name: "PPT · Permiso protección temporal", charset: "num", maxLength: 15, personTypes: ["2"], foreign: false },
  "50": { code: "50", name: "NIT de otro país", charset: "alnum", maxLength: 20, personTypes: ["1"], foreign: true },
  "91": { code: "91", name: "NUIP", charset: "num", maxLength: 10, personTypes: ["2"], foreign: false },
};

export const DOCUMENT_TYPE_CODES = Object.keys(DOCUMENT_TYPES) as DocumentType[];

/** Reserved for the built-in "consumidor final"; cannot be a party. */
export const RESERVED_DOCUMENT_NUMBER = "222222222222";

export const NIT_MIN_LENGTH = 6;

/** Charset, reserved-number, length and NIT minimum checks for a document number (stored without DV, dots or spaces). Empty list = valid. */
export function documentNumberErrors(documentType: DocumentType, documentNumber: string): string[] {
  const def = DOCUMENT_TYPES[documentType];
  const errors: string[] = [];
  if (def.charset === "num" && !/^\d+$/.test(documentNumber)) errors.push(`${def.code}: solo dígitos`);
  if (def.charset === "alnum" && !/^[A-Za-z0-9]+$/.test(documentNumber)) errors.push(`${def.code}: solo letras y números`);
  if (documentNumber.replace(/\D/g, "") === RESERVED_DOCUMENT_NUMBER) errors.push("222222222222 está reservado para “consumidor final”; no se registra como tercero");
  if (documentNumber.length > def.maxLength) errors.push(`${def.code}: máximo ${def.maxLength} caracteres`);
  if (documentType === "31" && documentNumber.length < NIT_MIN_LENGTH) errors.push(`31: mínimo ${NIT_MIN_LENGTH} dígitos`);
  return errors;
}
