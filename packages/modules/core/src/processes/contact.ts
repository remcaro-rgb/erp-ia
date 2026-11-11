import { assertRecordRight, customData, DEFAULT_PHONE_CC, defineProcess, ProcessError, validateEmail, validatePhone, visibleExtra, type CustomData, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { blank, defined, freeJsonb, idInput, idOutput, jsonb, rejectErrors, writableParty } from "./common";
import { clearable, extra, extraFree, id, phoneCc } from "./schemas";

// Contacts of a party (design §5.18): people at a customer or supplier, shown in the record's
// Contactos tab. A contact is written only through a party the caller may write (visible, and every
// non-employee kind inside the party scope). E-mail and phones follow rule 11 (validateEmail,
// validatePhone). A contact is part of its party: writing one needs the modify right on the party (kernel.record_access, Task 9
// review I4). Delete is a hard delete: contacts are not documents (rule 9); the audit keeps the row.

const fields = {
  name: z.string().trim().min(1).max(200),
  jobTitle: clearable(z.string().trim().max(100)).optional(),
  email: clearable(z.string().trim()).optional(),
  phoneCc: phoneCc.optional(),
  phone: clearable(z.string().trim()).optional(),
  ext: clearable(z.string().regex(/^\d{1,6}$/)).optional(),
  mobileCc: phoneCc.optional(),
  mobile: clearable(z.string().trim()).optional(),
  extra,
  extraFree,
};
type ContactFields = Partial<z.output<z.ZodObject<typeof fields>>>;

/** The contact data rule 11 checks, as stored: calling codes without "+", a cleared value as null. */
type Contact = { email?: string | null; phone_cc: string; phone?: string | null; mobile_cc: string; mobile?: string | null };

const callingCode = (cc: string | undefined) => cc?.replace(/^\+/, "");

/** Rule 11 errors of the contact as it would be stored. */
function contactErrors(contact: Contact): string[] {
  const errors: string[] = [];
  const email = contact.email ? validateEmail(contact.email) : null;
  if (email) errors.push(`Correo: ${email}`);
  const phone = contact.phone ? validatePhone(contact.phone_cc, contact.phone) : null;
  if (phone) errors.push(`Teléfono: ${phone}`);
  const mobile = contact.mobile ? validatePhone(contact.mobile_cc, contact.mobile) : null;
  if (mobile) errors.push(`Celular: ${mobile}`);
  return errors;
}

/** Column values for the given fields; "" clears a column, undefined leaves it alone. */
function columns(ctx: ProcessContext, input: ContactFields, custom: CustomData) {
  return {
    name: input.name,
    job_title: blank(input.jobTitle),
    email: blank(input.email),
    phone_cc: callingCode(input.phoneCc),
    phone: blank(input.phone),
    ext: blank(input.ext),
    mobile_cc: callingCode(input.mobileCc),
    mobile: blank(input.mobile),
    extra: input.extra === undefined ? undefined : jsonb(ctx, custom.extra),
    extra_free: freeJsonb(ctx, input.extraFree),
  };
}

/** The party is writable by the caller (scope) and they hold its modify right (record_forbidden otherwise). */
async function writableContactParty(ctx: ProcessContext, partyId: string): Promise<void> {
  await writableParty(ctx, partyId);
  await assertRecordRight(ctx, "core.party", partyId, "modify");
}

/** The contact as stored, after checking its party may be written by the caller; `not_found` otherwise. */
async function writableContact(ctx: ProcessContext, contactId: string): Promise<Contact & { extra: Record<string, unknown> }> {
  const [contact] = await ctx.tx<(Required<Contact> & { party_id: string; extra: Record<string, unknown> })[]>`
    select party_id, email, phone_cc, phone, mobile_cc, mobile, extra from core.party_contacts where id = ${contactId}`;
  if (!contact) throw new ProcessError("not_found", `contact ${contactId} not found`);
  await writableContactParty(ctx, contact.party_id);
  return contact;
}

export const contactCreate = defineProcess({
  id: "core.contact.create",
  module: "core",
  kind: "create",
  recordAccess: "handler",
  feature: "core.parties",
  description: "Agrega un contacto (persona) a un tercero",
  input: z.object({ partyId: id, ...fields }),
  output: idOutput,
  handler: async (ctx, { partyId, ...input }) => {
    await writableContactParty(ctx, partyId);
    const custom = await customData(ctx, "core.party_contact", null, input.extra);
    const row = {
      ...columns(ctx, input, custom),
      phone_cc: callingCode(input.phoneCc) ?? DEFAULT_PHONE_CC,
      mobile_cc: callingCode(input.mobileCc) ?? DEFAULT_PHONE_CC,
    };
    rejectErrors("core.contact.create", [...contactErrors(row), ...custom.errors]);
    const [inserted] = await ctx.tx<{ id: string }[]>`
      insert into core.party_contacts ${ctx.tx({ company_id: ctx.companyId, party_id: partyId, ...defined(row) })}
      returning id`;
    return { id: inserted!.id };
  },
});

export const contactUpdate = defineProcess({
  id: "core.contact.update",
  module: "core",
  kind: "update",
  recordAccess: "handler",
  feature: "core.parties",
  description: "Actualiza los datos de un contacto de un tercero",
  input: z.object(fields).partial().extend({ id }),
  output: idOutput,
  handler: async (ctx, { id: contactId, ...input }) => {
    const stored = await writableContact(ctx, contactId);
    const custom = await customData(ctx, "core.party_contact", stored.extra, input.extra);
    const set = defined(columns(ctx, input, custom));
    // The stored number is re-checked against a new calling code and vice versa.
    rejectErrors("core.contact.update", [...contactErrors({ ...stored, ...(set as Partial<Contact>) }), ...custom.errors]);
    if (Object.keys(set).length > 0) await ctx.tx`update core.party_contacts set ${ctx.tx(set)} where id = ${contactId}`;
    return { id: contactId };
  },
});

export const contactDelete = defineProcess({
  id: "core.contact.delete",
  module: "core",
  kind: "delete",
  recordAccess: "handler",
  feature: "core.parties",
  description: "Elimina un contacto de un tercero",
  input: idInput,
  output: idOutput,
  handler: async (ctx, { id: contactId }) => {
    await writableContact(ctx, contactId);
    await ctx.tx`delete from core.party_contacts where id = ${contactId}`;
    return { id: contactId };
  },
});

export const contactList = defineProcess({
  id: "core.contact.list",
  module: "core",
  kind: "consult",
  feature: "core.parties",
  description: "Lista los contactos de un tercero con los campos que el rol puede ver",
  input: z.object({ partyId: id }),
  output: z.array(
    z.object({
      id: z.string(),
      partyId: z.string(),
      seq: z.number(),
      name: z.string(),
      jobTitle: z.string().nullable(),
      email: z.string().nullable(),
      phoneCc: z.string().nullable(),
      phone: z.string().nullable(),
      ext: z.string().nullable(),
      mobileCc: z.string().nullable(),
      mobile: z.string().nullable(),
      extra: z.record(z.string(), z.unknown()).nullable(),
      extraFree: z.array(z.object({ name: z.string(), value: z.string() })).nullable(),
    }),
  ),
  handler: async (ctx, { partyId }) => {
    // The party must be one the caller sees (company and party scope); its contacts follow.
    const visible = await ctx.tx`select 1 from core.v_parties where id = ${partyId}`;
    if (visible.length === 0) throw new ProcessError("not_found", `party ${partyId} not found`);
    const rows = await ctx.tx`select * from core.v_party_contacts where party_id = ${partyId} order by seq`;
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id as string,
        partyId,
        seq: Number(row.seq),
        name: row.name as string,
        jobTitle: (row.job_title as string | null) ?? null,
        email: (row.email as string | null) ?? null,
        phoneCc: (row.phone_cc as string | null) ?? null,
        phone: (row.phone as string | null) ?? null,
        ext: (row.ext as string | null) ?? null,
        mobileCc: (row.mobile_cc as string | null) ?? null,
        mobile: (row.mobile as string | null) ?? null,
        extra: await visibleExtra(ctx, "core.party_contact", row.extra as Record<string, unknown> | null),
        extraFree: (row.extra_free as { name: string; value: string }[] | null) ?? null,
      })),
    );
  },
});

export const CONTACT_PROCESSES = [contactCreate, contactUpdate, contactDelete, contactList];
