import type { CountryPack } from "@erp/kernel";
import { accounting } from "./accounting";
import { codeLabel } from "./code-label";
import { DOCUMENT_TYPE_CODES } from "./document-types";
import { nitCheckDigit, validateTaxId } from "./nit";
import { taxes } from "./taxes";
import { validateParty } from "./validate-party";
import { validateProduct } from "./validate-product";

export const co: CountryPack = {
  code: "CO",
  validateTaxId,
  documentTypes: DOCUMENT_TYPE_CODES,
  defaultCurrency: "COP",
  locale: "es-CO",
  validateParty,
  validateProduct,
  codeLabel,
  // The DIAN's name of the tax id, the same in every language a Colombian document prints in.
  taxIdLabel: () => "NIT",
  taxIdText: (taxId) => (/^\d{5,15}$/.test(taxId) ? `${taxId}-${nitCheckDigit(taxId)}` : taxId),
  accounting,
  taxes,
};

export { codeLabel } from "./code-label";
export { nitCheckDigit, validateTaxId } from "./nit";
export { validateParty } from "./validate-party";
export { validateProduct } from "./validate-product";
export { gtinValid } from "./gtin";
export { DOCUMENT_TYPES, DOCUMENT_TYPE_CODES, RESERVED_DOCUMENT_NUMBER } from "./document-types";
export { DIAN_COUNTRY_CODES, NOT_RESPONSIBLE, TAX_RESPONSIBILITIES, TAX_SCHEMES } from "./tax-tables";
export { DEPARTMENTS, MUNICIPALITIES, departmentName, isMunicipalityCode, municipalityName } from "./dane";
export { INC_RATES, ITEM_ID_SCHEMES, IVA_RATES, OTHER_TAXES, PRICE_TYPES, UOM_CODES } from "./item-tables";
export { ROUNDING, UVT, computeTaxes, round2, uvtFor } from "./taxes";
export { ResolutionError, isResolution, nextInvoiceNumber } from "./einvoice/resolution";
export type { InvoiceNumber, NumberedDocument, NumberingTx, Resolution, ResolutionErrorCode } from "./einvoice/resolution";
