import type { CountryPack } from "@erp/kernel";
import { DOCUMENT_TYPE_CODES } from "./document-types";
import { validateTaxId } from "./nit";
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
};

export { nitCheckDigit, validateTaxId } from "./nit";
export { validateParty } from "./validate-party";
export { validateProduct } from "./validate-product";
export { gtinValid } from "./gtin";
export { DOCUMENT_TYPES, DOCUMENT_TYPE_CODES, RESERVED_DOCUMENT_NUMBER } from "./document-types";
export { DIAN_COUNTRY_CODES, NOT_RESPONSIBLE, TAX_RESPONSIBILITIES, TAX_SCHEMES } from "./tax-tables";
export { DEPARTMENTS, MUNICIPALITIES, departmentName, municipalityName } from "./dane";
export { INC_RATES, ITEM_ID_SCHEMES, IVA_RATES, OTHER_TAXES, PRICE_TYPES, UOM_CODES } from "./item-tables";
