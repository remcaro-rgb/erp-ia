import { nitCheckDigit } from "@erp/loc-co/nit";
import { emailProblem, phoneProblem } from "../fields/field-model";
import type { CodeOption } from "./save-model";

// The party form's pure rules (prototype `openPartyForm` / `pfSet` / `pfResp` / `renderPartyForm`, design §5.8a,
// §5.18). The code tables and their defaults come from the company's country pack through the page; the check digit
// is the pack's own algorithm (`@erp/loc-co/nit`). Everything else the pack decides when the process validates.

export interface DocumentTypeOption extends CodeOption {
  charset: "num" | "alnum";
  maxLength: number;
  /** Person types (`1` jurídica, `2` natural) it applies to. */
  personTypes: readonly string[];
  /** For parties abroad only. */
  foreign: boolean;
}

/** The country pack's tables the form offers, built by the page. */
export interface PartyTables {
  documentTypes: readonly DocumentTypeOption[];
  responsibilities: readonly CodeOption[];
  /** The responsibility that excludes the others (`R-99-PN`, no responsable). */
  exclusiveResponsibility: string;
  taxSchemes: readonly CodeOption[];
  countries: readonly CodeOption[];
  /** The company's own country: parties there carry department and municipality codes. */
  homeCountry: string;
  departments: readonly CodeOption[];
  municipalities: readonly (CodeOption & { departmentCode: string })[];
  /** Document types that carry a computed check digit (NIT). */
  checkDigitTypes: readonly string[];
  /** The document type to switch to per person type when the current one stops applying. */
  preferredDocumentType: { home: Record<string, string>; abroad: Record<string, string> };
  limits: { legalName: number; namePart: number; address: number };
}

export type Relation = "customer" | "supplier" | "both";

export interface PartyDraft {
  relation: Relation;
  /** Kinds the form does not edit (employee), kept as they are. */
  otherKinds: string[];
  personType: string;
  documentType: string;
  documentNumber: string;
  legalName: string;
  firstSurname: string;
  secondSurname: string;
  firstName: string;
  otherNames: string;
  tradeName: string;
  taxResponsibilities: string[];
  taxScheme: string;
  ciiu: string;
  countryCode: string;
  departmentCode: string;
  municipalityCode: string;
  addressLine: string;
  postalCode: string;
  invoiceEmail: string;
  supplierEmail: string;
  phoneCc: string;
  phone: string;
  contactName: string;
  creditLimit: number | null;
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function relationOf(kind: readonly string[]): Relation {
  const customer = kind.includes("customer");
  const supplier = kind.includes("supplier");
  return customer && supplier ? "both" : supplier ? "supplier" : "customer";
}

export const includesCustomer = (r: Relation) => r !== "supplier";
export const includesSupplier = (r: Relation) => r !== "customer";

/** The form's draft of a stored party (the consult row), or of a new one. */
export function partyDraft(record: Record<string, unknown> | null, tables: Pick<PartyTables, "homeCountry" | "exclusiveResponsibility" | "preferredDocumentType">): PartyDraft {
  const kind = list(record?.kind);
  const credit = record?.credit_limit;
  return {
    relation: relationOf(kind),
    otherKinds: kind.filter((k) => k !== "customer" && k !== "supplier"),
    personType: str(record?.person_type) || "1",
    documentType: str(record?.document_type) || (tables.preferredDocumentType.home["1"] ?? ""),
    documentNumber: str(record?.document_number),
    legalName: str(record?.legal_name),
    firstSurname: str(record?.first_surname),
    secondSurname: str(record?.second_surname),
    firstName: str(record?.first_name),
    otherNames: str(record?.other_names),
    tradeName: str(record?.trade_name),
    taxResponsibilities: record ? list(record.tax_responsibilities) : [tables.exclusiveResponsibility],
    taxScheme: str(record?.tax_scheme) || "ZZ",
    ciiu: str(record?.ciiu),
    countryCode: str(record?.country_code) || tables.homeCountry,
    departmentCode: str(record?.department_code),
    municipalityCode: str(record?.municipality_code),
    addressLine: str(record?.address_line),
    postalCode: str(record?.postal_code),
    invoiceEmail: str(record?.invoice_email),
    supplierEmail: str(record?.supplier_email),
    phoneCc: str(record?.phone_cc) || "57",
    phone: str(record?.phone),
    contactName: str(record?.contact_name),
    creditLimit: credit === null || credit === undefined || credit === "" ? null : Number(credit),
  };
}

/** Document types for the person type and the country (prototype: domestic types at home, foreign ones abroad). */
export function documentTypesFor(tables: PartyTables, personType: string, countryCode: string): DocumentTypeOption[] {
  const home = countryCode === tables.homeCountry;
  return tables.documentTypes.filter((d) => d.personTypes.includes(personType) && d.foreign === !home);
}

/** Keeps the document type when it still applies, else switches to the preferred one (prototype `pfSet`). */
function fitDocumentType(draft: PartyDraft, tables: PartyTables): PartyDraft {
  const allowed = documentTypesFor(tables, draft.personType, draft.countryCode);
  if (allowed.some((d) => d.code === draft.documentType)) return draft;
  const side = draft.countryCode === tables.homeCountry ? "home" : "abroad";
  const preferred = tables.preferredDocumentType[side][draft.personType];
  const next = allowed.find((d) => d.code === preferred) ?? allowed[0];
  return next ? { ...draft, documentType: next.code } : draft;
}

type TextKey = Exclude<keyof PartyDraft, "relation" | "otherKinds" | "taxResponsibilities" | "creditLimit">;

/** One field changed, with the prototype's knock-on rules: person type and country fix the document type; leaving the home country clears DANE data; a new department clears the municipality. */
export function setPartyField(draft: PartyDraft, key: TextKey, value: string, tables: PartyTables): PartyDraft {
  let next: PartyDraft = { ...draft, [key]: value };
  if (key === "personType") {
    // The previous person type's usual document follows the person type (prototype: a natural person moves from NIT to cédula).
    const side = draft.countryCode === tables.homeCountry ? "home" : "abroad";
    const usual = tables.preferredDocumentType[side];
    if (draft.documentType === usual[draft.personType] && usual[value]) next = { ...next, documentType: usual[value]! };
  }
  if (key === "countryCode" && value !== tables.homeCountry) next = { ...next, departmentCode: "", municipalityCode: "", postalCode: "" };
  if (key === "departmentCode") next = { ...next, municipalityCode: "" };
  if (key === "personType" || key === "countryCode") next = fitDocumentType(next, tables);
  return next;
}

/** Ticks or unticks a responsibility; the exclusive one (`R-99-PN`) clears the others and is cleared by them (prototype `pfResp`). */
export function toggleResponsibility(draft: PartyDraft, code: string, on: boolean, exclusive: string): PartyDraft {
  if (on && code === exclusive) return { ...draft, taxResponsibilities: [exclusive] };
  const rest = draft.taxResponsibilities.filter((r) => r !== code && (on ? r !== exclusive : true));
  return { ...draft, taxResponsibilities: on ? [...rest, code] : rest };
}

/** The check digit the DIAN algorithm gives the number, for document types that carry one; null while it cannot be computed. */
export function checkDigitOf(draft: Pick<PartyDraft, "documentType" | "documentNumber">, tables: Pick<PartyTables, "checkDigitTypes">): string | null {
  if (!tables.checkDigitTypes.includes(draft.documentType) || !/^\d{1,15}$/.test(draft.documentNumber)) return null;
  return String(nitCheckDigit(draft.documentNumber));
}

/** A natural person's name for documents: surnames then names (the pack composes the same). */
export const composedName = (d: Pick<PartyDraft, "firstSurname" | "secondSurname" | "firstName" | "otherNames">): string =>
  [d.firstSurname, d.secondSurname, d.firstName, d.otherNames].map((p) => p.trim()).filter(Boolean).join(" ");

export type DocumentProblem = { key: "digits" } | { key: "alnum" } | { key: "max"; count: number };

/** Charset and length of the number for its type, from the pack's table (the prototype checks it while typing). */
export function documentProblem(draft: PartyDraft, tables: PartyTables): DocumentProblem | null {
  const def = tables.documentTypes.find((d) => d.code === draft.documentType);
  const n = draft.documentNumber;
  if (!def || n === "") return null;
  if (def.charset === "num" && !/^\d+$/.test(n)) return { key: "digits" };
  if (def.charset === "alnum" && !/^[A-Za-z0-9]+$/.test(n)) return { key: "alnum" };
  if (n.length > def.maxLength) return { key: "max", count: def.maxLength };
  return null;
}

/** Whether the form may be sent: the number fits its type, the e-mails and the phone are well formed. */
export function partyBlocked(draft: PartyDraft, tables: PartyTables): boolean {
  return (
    documentProblem(draft, tables) !== null ||
    (includesCustomer(draft.relation) && emailProblem(draft.invoiceEmail) !== null) ||
    (includesSupplier(draft.relation) && emailProblem(draft.supplierEmail) !== null) ||
    phoneProblem(draft.phoneCc, draft.phone) !== null
  );
}

/**
 * The input of `core.party.create` / `core.party.update`. Cleared fields go as "" (the pack treats them as absent, so
 * an update clears them); the e-mail of a relation the party does not have is cleared; the credit limit goes only
 * when the role sees it (a masked value never comes back as a change).
 */
export function partyInput(draft: PartyDraft, options: { creditLimitVisible: boolean }): Record<string, unknown> {
  const natural = draft.personType !== "1";
  const kind = [...(draft.relation === "both" ? ["customer", "supplier"] : [draft.relation]), ...draft.otherKinds];
  return {
    kind,
    personType: draft.personType,
    documentType: draft.documentType,
    documentNumber: draft.documentNumber.trim(),
    legalName: natural ? composedName(draft) : draft.legalName.trim(),
    firstSurname: natural ? draft.firstSurname : "",
    secondSurname: natural ? draft.secondSurname : "",
    firstName: natural ? draft.firstName : "",
    otherNames: natural ? draft.otherNames : "",
    tradeName: draft.tradeName,
    taxResponsibilities: draft.taxResponsibilities,
    taxScheme: draft.taxScheme,
    ciiu: draft.ciiu,
    countryCode: draft.countryCode,
    departmentCode: draft.departmentCode,
    municipalityCode: draft.municipalityCode,
    addressLine: draft.addressLine,
    postalCode: draft.postalCode,
    invoiceEmail: includesCustomer(draft.relation) ? draft.invoiceEmail : "",
    supplierEmail: includesSupplier(draft.relation) ? draft.supplierEmail : "",
    phoneCc: draft.phoneCc,
    phone: draft.phone,
    contactName: draft.contactName,
    ...(options.creditLimitVisible && draft.creditLimit !== null ? { creditLimit: draft.creditLimit } : {}),
  };
}

/** The stored record's missing DIAN data, or null for a record not saved yet. */
export function storedPending(record: Record<string, unknown> | null): string[] | null {
  if (!record) return null;
  return Array.isArray(record.dian_missing) ? record.dian_missing.map(String) : [];
}
