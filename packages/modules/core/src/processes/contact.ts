import { defineProcess, ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { assertVisibleParty, defined } from "./common";
import { clearable, extra, id, phoneCc, phoneNumber } from "./schemas";

// Contacts of a party (design §5.18): people at a customer or supplier, shown in the record's
// Contactos tab. A contact is reachable only through a party visible to the caller (company and
// party scope). Delete is a hard delete: contacts are not documents (rule 9); the audit keeps the row.

const fields = {
  name: z.string().trim().min(1).max(200),
  jobTitle: clearable(z.string().trim().max(100)).optional(),
  email: clearable(z.email().max(100)).optional(),
  phoneCc: phoneCc.optional(),
  phone: clearable(phoneNumber).optional(),
  ext: clearable(z.string().regex(/^\d{1,6}$/)).optional(),
  mobileCc: phoneCc.optional(),
  mobile: clearable(phoneNumber).optional(),
  extra,
};
type ContactFields = Partial<z.output<z.ZodObject<typeof fields>>>;

const idInput = z.object({ id });
const idOutput = z.object({ id: z.string() });

/** Column values for the given fields; "" clears a column. */
function columns(ctx: ProcessContext, input: ContactFields) {
  const blank = (v: string | undefined) => (v === "" ? null : v);
  return {
    name: input.name,
    job_title: blank(input.jobTitle),
    email: blank(input.email),
    phone_cc: input.phoneCc,
    phone: blank(input.phone),
    ext: blank(input.ext),
    mobile_cc: input.mobileCc,
    mobile: blank(input.mobile),
    extra: input.extra === undefined ? undefined : ctx.tx.json(input.extra as Parameters<typeof ctx.tx.json>[0]),
  };
}

/** The contact's party, after checking the party is visible to the caller; `not_found` otherwise. */
async function partyOf(ctx: ProcessContext, contactId: string): Promise<string> {
  const [contact] = await ctx.tx<{ party_id: string }[]>`select party_id from core.party_contacts where id = ${contactId}`;
  if (!contact) throw new ProcessError("not_found", `contact ${contactId} not found`);
  await assertVisibleParty(ctx, contact.party_id);
  return contact.party_id;
}

export const contactCreate = defineProcess({
  id: "core.contact.create",
  module: "core",
  kind: "create",
  feature: "core.parties",
  description: "Agrega un contacto (persona) a un tercero",
  input: z.object({ partyId: id, ...fields }),
  output: idOutput,
  handler: async (ctx, { partyId, ...input }) => {
    await assertVisibleParty(ctx, partyId);
    // Unset fields are left out so the column defaults (calling codes) apply.
    const [inserted] = await ctx.tx<{ id: string }[]>`
      insert into core.party_contacts ${ctx.tx({ company_id: ctx.companyId, party_id: partyId, ...defined(columns(ctx, input)) })}
      returning id`;
    return { id: inserted!.id };
  },
});

export const contactUpdate = defineProcess({
  id: "core.contact.update",
  module: "core",
  kind: "update",
  feature: "core.parties",
  description: "Actualiza los datos de un contacto de un tercero",
  input: z.object(fields).partial().extend({ id }),
  output: idOutput,
  handler: async (ctx, { id: contactId, ...input }) => {
    await partyOf(ctx, contactId);
    const set = defined(columns(ctx, input));
    if (Object.keys(set).length > 0) await ctx.tx`update core.party_contacts set ${ctx.tx(set)} where id = ${contactId}`;
    return { id: contactId };
  },
});

export const contactDelete = defineProcess({
  id: "core.contact.delete",
  module: "core",
  kind: "delete",
  feature: "core.parties",
  description: "Elimina un contacto de un tercero",
  input: idInput,
  output: idOutput,
  handler: async (ctx, { id: contactId }) => {
    await partyOf(ctx, contactId);
    await ctx.tx`delete from core.party_contacts where id = ${contactId}`;
    return { id: contactId };
  },
});

export const CONTACT_PROCESSES = [contactCreate, contactUpdate, contactDelete];
