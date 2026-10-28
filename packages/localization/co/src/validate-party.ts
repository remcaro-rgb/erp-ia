import { DEFAULT_PHONE_CC, validateEmail, validatePhone, type PartyFiscalInput, type PartyValidation } from "@erp/kernel";
import { DEPARTMENTS } from "./dane";
import { DOCUMENT_TYPES, documentNumberErrors } from "./document-types";
import { nitCheckDigit } from "./nit";
import { NOT_RESPONSIBLE, TAX_RESPONSIBILITIES, TAX_SCHEMES } from "./tax-tables";
import { clean } from "./util";

const LIMITS = { legalName: 450, tradeName: 450, namePart: 60, address: 200, ciiu: 4, postal: 6 } as const;

const NAME_PARTS = [
  ["firstSurname", "Primer apellido"],
  ["secondSurname", "Segundo apellido"],
  ["firstName", "Primer nombre"],
  ["otherNames", "Otros nombres"],
] as const;

/**
 * Colombian party validation (design §5.8a). `errors` are format/length/coherence violations that block the save;
 * `missing` is data required for e-invoicing or exógena that only sets `dian_status`.
 */
export function validateParty(input: PartyFiscalInput): PartyValidation {
  const errors: string[] = [];
  const missing: string[] = [];

  const documentNumber = input.documentNumber.trim();
  const countryCode = input.countryCode.trim().toUpperCase();
  const domestic = countryCode === "CO";
  const doc = DOCUMENT_TYPES[input.documentType];
  const departmentCode = clean(input.departmentCode);
  const municipalityCode = clean(input.municipalityCode);
  const customer = input.kind.includes("customer");
  const supplier = input.kind.includes("supplier");

  // Document
  let checkDigit: string | null = null;
  if (!doc) {
    errors.push("Tipo de documento inválido");
  } else {
    if (!doc.personTypes.includes(input.personType)) {
      errors.push(`${doc.name} no aplica a ${input.personType === "1" ? "persona jurídica" : "persona natural"}`);
    }
    if (!documentNumber) {
      missing.push("Número de documento");
    } else {
      const numberErrors = documentNumberErrors(input.documentType, documentNumber);
      errors.push(...numberErrors);
      if (input.documentType === "31" && numberErrors.length === 0) checkDigit = String(nitCheckDigit(documentNumber));
    }
    if (doc.foreign && domestic) errors.push(`${doc.name} corresponde a un tercero del exterior: cambia el país`);
    if (!doc.foreign && !domestic) errors.push("Un tercero del exterior debe usar pasaporte (41), documento extranjero (42) o NIT de otro país (50)");
  }
  if (!/^[A-Z]{2}$/.test(countryCode)) errors.push("País: código ISO de 2 letras");

  // Names
  const parts = {
    firstSurname: clean(input.firstSurname),
    secondSurname: clean(input.secondSurname),
    firstName: clean(input.firstName),
    otherNames: clean(input.otherNames),
  };
  let legalName: string;
  if (input.personType === "1") {
    legalName = clean(input.legalName) ?? "";
    if (!legalName) missing.push("Razón social");
    if (legalName.length > LIMITS.legalName) errors.push(`Razón social: máximo ${LIMITS.legalName} caracteres`);
  } else {
    if (!parts.firstSurname) missing.push("Primer apellido");
    if (!parts.firstName) missing.push("Primer nombre");
    for (const [key, label] of NAME_PARTS) {
      const value = parts[key] ?? "";
      if (value.length > LIMITS.namePart) errors.push(`${label}: máximo ${LIMITS.namePart} caracteres`);
      if (/\d/.test(value)) errors.push(`${label}: no admite dígitos`);
    }
    legalName = [parts.firstSurname, parts.secondSurname, parts.firstName, parts.otherNames].filter(Boolean).join(" ");
  }
  const tradeName = clean(input.tradeName);
  if (tradeName && tradeName.length > LIMITS.tradeName) errors.push(`Nombre comercial: máximo ${LIMITS.tradeName} caracteres`);

  // Tax
  const responsibilities = input.taxResponsibilities.map((r) => r.trim()).filter(Boolean);
  if (responsibilities.length === 0) missing.push("Responsabilidad fiscal");
  for (const r of responsibilities) {
    if (!TAX_RESPONSIBILITIES.some((t) => t.code === r)) errors.push(`Responsabilidad fiscal inválida: ${r}`);
  }
  if (responsibilities.includes(NOT_RESPONSIBLE) && responsibilities.length > 1) {
    errors.push("R-99-PN (no responsable) no se combina con otras responsabilidades");
  } else if (input.personType === "1" && responsibilities.includes(NOT_RESPONSIBLE) && input.taxScheme === "01") {
    errors.push("Responsable de IVA (tributo 01) contradice R-99-PN");
  }
  if (!TAX_SCHEMES.some((t) => t.code === input.taxScheme)) errors.push("Tributo inválido");
  const ciiu = clean(input.ciiu);
  if (ciiu && !/^\d{4}$/.test(ciiu)) errors.push(`Actividad económica CIIU: ${LIMITS.ciiu} dígitos`);

  // Location
  const postalCode = clean(input.postalCode);
  if (domestic) {
    if (!departmentCode) missing.push("Departamento (DANE)");
    else if (!DEPARTMENTS.some((d) => d.code === departmentCode)) errors.push("Departamento DANE inválido");
    if (!municipalityCode) missing.push("Municipio (DANE)");
    else if (!/^\d{5}$/.test(municipalityCode)) errors.push("Municipio DANE: 5 dígitos");
    else if (departmentCode && !municipalityCode.startsWith(departmentCode)) errors.push("El municipio no pertenece al departamento");
    if (postalCode && !/^\d{6}$/.test(postalCode)) errors.push(`Código postal: ${LIMITS.postal} dígitos`);
  }
  const addressLine = clean(input.addressLine);
  if (!addressLine) missing.push("Dirección");
  else if (addressLine.length > LIMITS.address) errors.push(`Dirección: máximo ${LIMITS.address} caracteres`);

  // Contact
  const invoiceEmail = clean(input.invoiceEmail);
  const supplierEmail = clean(input.supplierEmail);
  if (customer && !invoiceEmail) missing.push("Correo para recibir facturas electrónicas");
  if (supplier && !supplierEmail) missing.push("Correo para enviar documentos al proveedor");
  const invoiceEmailError = invoiceEmail ? validateEmail(invoiceEmail) : null;
  if (invoiceEmailError) errors.push(`Correo de facturas: ${invoiceEmailError}`);
  const supplierEmailError = supplierEmail ? validateEmail(supplierEmail) : null;
  if (supplierEmailError) errors.push(`Correo del proveedor: ${supplierEmailError}`);
  const phoneCc = (clean(input.phoneCc) ?? DEFAULT_PHONE_CC).replace(/^\+/, "");
  const phone = clean(input.phone);
  const phoneErrorText = phone ? validatePhone(phoneCc, phone) : null;
  if (phoneErrorText) errors.push(`Teléfono: ${phoneErrorText}`);

  return {
    errors,
    missing,
    normalized: {
      ...input,
      documentNumber,
      legalName,
      firstSurname: parts.firstSurname,
      secondSurname: parts.secondSurname,
      firstName: parts.firstName,
      otherNames: parts.otherNames,
      tradeName,
      taxResponsibilities: responsibilities,
      ciiu,
      countryCode,
      // A foreign party carries no DANE data: cleared instead of rejected (stale values after a country change).
      departmentCode: domestic ? departmentCode : undefined,
      municipalityCode: domestic ? municipalityCode : undefined,
      addressLine,
      postalCode: domestic ? postalCode : undefined,
      invoiceEmail,
      supplierEmail,
      phoneCc: phone ? phoneCc : clean(input.phoneCc),
      phone,
      checkDigit,
    },
  };
}
