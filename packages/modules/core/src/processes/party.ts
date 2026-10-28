import { customData, defineProcess, ProcessError, visibleExtra, type CustomData, type PartyValidation, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import {
  assertScopeCovers,
  companyPack,
  defined,
  dianStatus,
  freeJsonb,
  idInput,
  idOutput,
  jsonb,
  num,
  refuseDuplicate,
  rejectErrors,
  str,
  undefinedAsNull,
  writableParty,
} from "./common";
import { documentType, extra, extraFree, extraPatch, id, optionalText, partyKind, taxScheme } from "./schemas";

// Parties (design §5.8a, §5.18): customers, suppliers and employees as one model. The company's
// country pack validates every create and update: its errors refuse the run with invalid_input, its
// missing data is stored as dian_status / dian_missing. The party scope bounds reads (core.v_parties)
// and writes (every non-employee kind of the record, stored and written, must be in the scope).

const fields = {
  kind: z.array(partyKind).min(1),
  personType: z.enum(["1", "2"]),
  documentType,
  documentNumber: z.string().trim().min(1),
  legalName: optionalText,
  firstSurname: optionalText,
  secondSurname: optionalText,
  firstName: optionalText,
  otherNames: optionalText,
  tradeName: optionalText,
  taxResponsibilities: z.array(z.string()),
  taxScheme,
  ciiu: optionalText,
  countryCode: z.string(),
  departmentCode: optionalText,
  municipalityCode: optionalText,
  addressLine: optionalText,
  postalCode: optionalText,
  invoiceEmail: optionalText,
  supplierEmail: optionalText,
  phoneCc: optionalText,
  phone: optionalText,
  creditLimit: z.number().min(0).optional(),
  contactName: optionalText,
  extra,
  extraFree,
};

const createInput = z.object({
  ...fields,
  taxResponsibilities: fields.taxResponsibilities.default(["R-99-PN"]),
  taxScheme: fields.taxScheme.default("ZZ"),
  countryCode: fields.countryCode.default("CO"),
});
type PartyInput = z.output<typeof createInput>;

const updateInput = z.object(fields).partial().extend({ id, extraPatch });

/** Unique constraint on (company_id, document_type, document_number). */
const DOCUMENT_KEY = "parties_company_id_document_type_document_number_key";

/** The stored record as a create input, so an update re-validates the whole merged record. */
function inputOf(row: Record<string, unknown>): PartyInput {
  return {
    kind: row.kind as PartyInput["kind"],
    personType: row.person_type as PartyInput["personType"],
    documentType: row.document_type as PartyInput["documentType"],
    documentNumber: String(row.document_number),
    legalName: str(row.legal_name),
    firstSurname: str(row.first_surname),
    secondSurname: str(row.second_surname),
    firstName: str(row.first_name),
    otherNames: str(row.other_names),
    tradeName: str(row.trade_name),
    taxResponsibilities: row.tax_responsibilities as string[],
    taxScheme: row.tax_scheme as PartyInput["taxScheme"],
    ciiu: str(row.ciiu),
    countryCode: String(row.country_code),
    departmentCode: str(row.department_code),
    municipalityCode: str(row.municipality_code),
    addressLine: str(row.address_line),
    postalCode: str(row.postal_code),
    invoiceEmail: str(row.invoice_email),
    supplierEmail: str(row.supplier_email),
    phoneCc: str(row.phone_cc),
    phone: str(row.phone),
    creditLimit: num(row.credit_limit),
    contactName: str(row.contact_name),
    extra: (row.extra as Record<string, unknown> | null) ?? undefined,
  };
}

/**
 * Validates with the company's pack (errors refuse the run), then with the company's custom fields, and maps the
 * normalized record to columns. A required custom field left empty is missing data next to the pack's.
 */
async function validated(ctx: ProcessContext, processId: string, input: PartyInput, custom: CustomData) {
  const kind = [...new Set(input.kind)];
  await assertScopeCovers(ctx, kind);
  const pack = await companyPack(ctx);
  const result: PartyValidation = pack.validateParty({ ...input, kind });
  rejectErrors(processId, result.errors);
  rejectErrors(processId, custom.errors);
  const missing = [...result.missing, ...custom.missing];
  const n = result.normalized;
  return {
    kind,
    person_type: n.personType,
    document_type: n.documentType,
    document_number: n.documentNumber,
    check_digit: n.checkDigit ?? undefined,
    legal_name: n.legalName,
    first_surname: n.firstSurname,
    second_surname: n.secondSurname,
    first_name: n.firstName,
    other_names: n.otherNames,
    trade_name: n.tradeName,
    tax_responsibilities: [...n.taxResponsibilities],
    tax_scheme: n.taxScheme,
    ciiu: n.ciiu,
    country_code: n.countryCode,
    department_code: n.departmentCode,
    municipality_code: n.municipalityCode,
    address_line: n.addressLine,
    postal_code: n.postalCode,
    invoice_email: n.invoiceEmail,
    supplier_email: n.supplierEmail,
    phone_cc: n.phoneCc,
    phone: n.phone,
    contact_name: input.contactName?.trim() || undefined,
    credit_limit: input.creditLimit,
    extra: jsonb(ctx, custom.extra),
    extra_free: freeJsonb(ctx, input.extraFree),
    dian_status: dianStatus(missing),
    dian_missing: missing,
  };
}

const duplicateDetail = (row: { document_type: string; document_number: string }) =>
  `Ya existe un tercero con documento ${row.document_type} ${row.document_number}`;

export const partyCreate = defineProcess({
  id: "core.party.create",
  module: "core",
  kind: "create",
  feature: "core.parties",
  description: "Crea un tercero (cliente, proveedor o empleado) con sus datos fiscales DIAN",
  input: createInput,
  output: idOutput,
  handler: async (ctx, input) => {
    const custom = await customData(ctx, "core.party", null, input.extra);
    const row = await validated(ctx, "core.party.create", input, custom);
    const [inserted] = await refuseDuplicate(
      "core.party.create",
      DOCUMENT_KEY,
      duplicateDetail(row),
      () => ctx.tx<{ id: string }[]>`insert into core.parties ${ctx.tx({ company_id: ctx.companyId, ...defined(row) })} returning id`,
    );
    await ctx.emit("core.party.created", { id: inserted!.id });
    return { id: inserted!.id };
  },
});

export const partyUpdate = defineProcess({
  id: "core.party.update",
  module: "core",
  kind: "update",
  feature: "core.parties",
  description: "Actualiza los datos de un tercero y recalcula su estado DIAN",
  input: updateInput,
  output: idOutput,
  handler: async (ctx, { id: partyId, extraPatch: patch, ...changes }) => {
    // The stored kinds must be in scope (a dual party is off limits to a one-sided role) …
    await writableParty(ctx, partyId);
    const [current] = await ctx.tx`select * from core.parties where id = ${partyId} for update`;
    if (!current) throw new ProcessError("not_found", `party ${partyId} not found`);
    const merged: PartyInput = { ...inputOf(current), ...defined(changes) };
    // … and so must the kinds it would have after the update (checked in validated).
    // Extra data: the stored document unless the request replaces it; required custom fields feed dian_missing.
    const custom = await customData(ctx, "core.party", current.extra as Record<string, unknown> | null, changes.extra, patch);
    const row = await validated(ctx, "core.party.update", merged, custom);
    const { credit_limit, extra: extraValue, extra_free: freeValue, ...rest } = row;
    // Unset optional columns are cleared; credit limit and extra data change only when given.
    const set = { ...undefinedAsNull(rest), ...defined({ credit_limit, extra: extraValue, extra_free: freeValue }) };
    await refuseDuplicate("core.party.update", DOCUMENT_KEY, duplicateDetail(row), () => ctx.tx`update core.parties set ${ctx.tx(set)} where id = ${partyId}`);
    await ctx.emit("core.party.updated", { id: partyId });
    return { id: partyId };
  },
});

export const partyDeactivate = defineProcess({
  id: "core.party.deactivate",
  module: "core",
  kind: "delete",
  feature: "core.parties",
  description: "Desactiva un tercero: deja de estar disponible para documentos nuevos",
  input: idInput,
  output: idOutput,
  handler: async (ctx, { id: partyId }) => {
    await writableParty(ctx, partyId);
    await ctx.tx`update core.parties set is_active = false where id = ${partyId}`;
    await ctx.emit("core.party.updated", { id: partyId });
    return { id: partyId };
  },
});

export const partyConsult = defineProcess({
  id: "core.party.consult",
  module: "core",
  kind: "consult",
  feature: "core.parties",
  description: "Consulta un tercero con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: partyId }) => {
    const [row] = await ctx.tx`select * from core.v_parties where id = ${partyId}`;
    if (!row) throw new ProcessError("not_found", `party ${partyId} not found`);
    return { ...row, id: partyId, extra: await visibleExtra(ctx, "core.party", row.extra) };
  },
});

export const PARTY_PROCESSES = [partyCreate, partyUpdate, partyDeactivate, partyConsult];
