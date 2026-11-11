// DIAN constants (ported from Serena src/lib/dian/constants.ts). Departments and municipalities are not
// duplicated: the pack's DANE tables (../dane.ts) are the single source.
import { CREDIT_NOTE_CONCEPTS } from "./tables/dian-tables";

export const DIAN_ENDPOINTS = {
  habilitacion: "https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc",
  produccion: "https://vpfe.dian.gov.co/WcfDianCustomerServices.svc",
} as const;

export const DIAN_SOAP_ACTIONS = {
  SendBillSync: "http://wcf.dian.colombia/IWcfDianCustomerServices/SendBillSync",
  GetStatus: "http://wcf.dian.colombia/IWcfDianCustomerServices/GetStatus",
  SendTestSetAsync: "http://wcf.dian.colombia/IWcfDianCustomerServices/SendTestSetAsync",
} as const;

/** NIT of the DIAN as authorization provider. */
export const DIAN_AUTH_NIT = "800197268";

export const DIAN_SIGNATURE_POLICY = {
  identifier: "https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf",
  description: "Política de firma para facturación electrónica de la República de Colombia",
} as const;

export const SCHEME_AGENCY = { id: "195", name: "CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" } as const;

/** Tax scheme codes of DIAN table 13.3.2 used in the CUFE. */
export const TAX_CODES = {
  IVA: { code: "01", name: "IVA" },
  INC: { code: "04", name: "INC" },
  ICA: { code: "03", name: "ICA" },
} as const;

/** Forma de pago (table 13.3.4.1): 1 contado, 2 crédito. */
export const PAYMENT_FORMS = { "1": "Contado", "2": "Crédito" } as const;

export const PAYMENT_MEANS_MAP: Record<string, { code: string; name: string }> = {
  bold: { code: "47", name: "Transferencia débito bancaria" },
  paypal: { code: "47", name: "Transferencia débito bancaria" },
  pse: { code: "42", name: "Consignación bancaria" },
  cash: { code: "10", name: "Efectivo" },
};

/** Table 13.2.4 by code (Anexo 1.9; Serena's copy was the 1.8 list, whose «5 Otros» 1.9 replaced): read from the pinned tables. */
export const CREDIT_NOTE_REASONS: Record<string, string> = Object.fromEntries(CREDIT_NOTE_CONCEPTS.map((c) => [c.code, c.name]));

export const CONSUMIDOR_FINAL = {
  documentType: "13",
  documentNumber: "222222222222",
  name: "Consumidor Final",
  personType: "2",
} as const;
