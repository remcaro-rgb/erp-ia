import { z } from "zod";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import type { ProcessContext } from "../process/context";
import { registeredVerifiers } from "../verify/adapters";
import { DEFAULT_PHONE_CC, validatePhone } from "../validation";
import { DOC_TEMPLATE_ENTITY } from "../templates/schema";
import { imageBytesMatch } from "../templates/variables";
import { fileStore } from "../files/store";
import { ADMIN_FEATURE, invalid, requireAdmin } from "./common";

// The company's own settings the admin keeps (design §5.13, §5.16, §6): its names and time zone, the files each entity
// requires (they feed invoice readiness, §5.17) and the external verification provider per kind of datum.

const timezoneValid = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const IMAGE_MIME = ["image/png", "image/jpeg"];

export const companyUpdate = defineProcess({
  id: "kernel.admin.company.update",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description:
    "Cambia la razón social, el nombre comercial, la zona horaria, la dirección, la ciudad, el teléfono o el logo de la empresa activa (lo que imprimen sus plantillas PDF)",
  input: z
    .object({
      legalName: z.string().trim().min(1, "La razón social es obligatoria").max(450, "Máximo 450 caracteres").optional(),
      tradeName: z.string().trim().max(450, "Máximo 450 caracteres").nullable().optional(),
      timezone: z.string().refine(timezoneValid, "Zona horaria desconocida (por ejemplo America/Bogota)").optional(),
      addressLine: z.string().trim().max(200, "Máximo 200 caracteres").nullable().optional(),
      city: z.string().trim().max(100, "Máximo 100 caracteres").nullable().optional(),
      /** Calling code without "+" (rule 11); sent with `phone`. */
      phoneCc: z.string().trim().optional(),
      phone: z.string().trim().nullable().optional(),
      /** A PNG or JPEG attachment of one of the company's PDF templates (entity kernel.doc_template), or null for none. */
      logoAttachmentId: z.uuid().nullable().optional(),
    })
    .refine((v) => Object.values(v).some((x) => x !== undefined), "Indica al menos un dato"),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    // Rule 11: country code + number, validated; stored without spaces or signs.
    let phone: { cc: string; number: string | null } | undefined;
    if (input.phone !== undefined) {
      const cc = (input.phoneCc ?? DEFAULT_PHONE_CC).replace(/^\+/, "");
      const number = input.phone ? input.phone.replace(/[\s().-]/g, "") : null;
      if (number !== null) {
        const problem = validatePhone(cc, number);
        if (problem) throw invalid(`invalid phone ${cc} ${number}`, problem);
      }
      phone = { cc, number };
    }
    if (input.logoAttachmentId) {
      const [logo] = await ctx.tx<{ mime_type: string; storage_path: string }[]>`
        select mime_type, storage_path from kernel.attachments
        where id = ${input.logoAttachmentId} and company_id = ${ctx.companyId} and entity = ${DOC_TEMPLATE_ENTITY} and removed_at is null`;
      const notALogo = () => invalid(`attachment ${input.logoAttachmentId} is not a logo`, "El logo debe ser una imagen PNG o JPEG adjunta a una plantilla");
      if (!logo || !IMAGE_MIME.includes(logo.mime_type)) throw notALogo();
      // The bytes, not only the type the upload claimed: a file that is not the image it says would break every print.
      const bytes = await (await fileStore()).get(logo.storage_path).catch(() => null);
      if (!bytes || !imageBytesMatch(bytes, logo.mime_type)) throw notALogo();
    }
    const keep = (value: unknown) => value === undefined;
    const rows = await ctx.tx<{ id: string }[]>`
      update kernel.companies set
        legal_name = coalesce(${input.legalName ?? null}, legal_name),
        trade_name = case when ${input.tradeName === undefined} then trade_name else nullif(${input.tradeName ?? ""}, '') end,
        timezone = coalesce(${input.timezone ?? null}, timezone),
        address_line = case when ${keep(input.addressLine)} then address_line else nullif(${input.addressLine ?? ""}, '') end,
        city = case when ${keep(input.city)} then city else nullif(${input.city ?? ""}, '') end,
        phone_cc = case when ${phone === undefined} then phone_cc else ${phone?.cc ?? null} end,
        phone = case when ${phone === undefined} then phone else ${phone?.number ?? null} end,
        logo_attachment_id = case when ${keep(input.logoAttachmentId)} then logo_attachment_id else ${input.logoAttachmentId ?? null}::uuid end
      where id = ${ctx.companyId}
      returning id`;
    if (rows.length === 0) throw new ProcessError("not_found", `company ${ctx.companyId} not found`);
    return { id: rows[0]!.id };
  },
});

const CONDITION = z.enum(["co", "co-juridica", "proveedor", "cliente"]).nullable();

/** Refuses a tag (trimmed, any case) the entity already requires, other than the definition `exceptId` itself. */
async function refuseDuplicateTag(ctx: ProcessContext, entity: string, tag: string, exceptId?: string): Promise<void> {
  const [row] = await ctx.tx`
    select 1 from kernel.required_attachments
    where company_id = ${ctx.companyId} and entity = ${entity} and lower(btrim(tag)) = lower(btrim(${tag})) and id is distinct from ${exceptId ?? null}`;
  if (row) throw invalid(`${entity} already requires ${tag}`, `Ya existe un archivo con la etiqueta ${tag.trim()} en esta entidad`);
}

export const requiredFileSet = defineProcess({
  id: "kernel.required_file.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Define o cambia un archivo que exige una entidad (etiqueta, tipo, si es obligatorio y cuándo aplica); sin él el registro no es facturable",
  input: z.object({
    id: z.uuid().optional(),
    entity: z.string().min(1),
    tag: z.string().trim().min(1, "La etiqueta es obligatoria").max(60, "Máximo 60 caracteres"),
    kind: z.enum(["pdf", "image", "any"]),
    required: z.boolean(),
    condition: CONDITION.default(null),
    description: z.string().trim().max(200, "Máximo 200 caracteres").default(""),
  }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    if (!ctx.registry.entities().some((e) => e.id === input.entity)) throw invalid(`unknown entity ${input.entity}`, `La entidad ${input.entity} no existe`);
    await refuseDuplicateTag(ctx, input.entity, input.tag, input.id);
    if (input.id) {
      const rows = await ctx.tx<{ id: string }[]>`
        update kernel.required_attachments set entity = ${input.entity}, tag = ${input.tag}, kind = ${input.kind}, required = ${input.required},
               condition = ${input.condition}, description = ${input.description}
        where id = ${input.id} and company_id = ${ctx.companyId}
        returning id`;
      if (rows.length === 0) throw new ProcessError("not_found", `required file ${input.id} not found`);
      return { id: rows[0]!.id };
    }
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into kernel.required_attachments (company_id, entity, tag, kind, required, condition, description)
      values (${ctx.companyId}, ${input.entity}, ${input.tag}, ${input.kind}, ${input.required}, ${input.condition}, ${input.description})
      returning id`;
    return { id: row!.id };
  },
});

export const requiredFileRemove = defineProcess({
  id: "kernel.required_file.remove",
  module: "kernel",
  kind: "delete",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Deja de exigir un archivo en una entidad; los archivos ya cargados se conservan",
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const rows = await ctx.tx<{ id: string }[]>`delete from kernel.required_attachments where id = ${id} and company_id = ${ctx.companyId} returning id`;
    if (rows.length === 0) throw new ProcessError("not_found", `required file ${id} not found`);
    return { id };
  },
});

export const verifierSet = defineProcess({
  id: "kernel.verifier.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Elige el proveedor de verificación externa de correos, teléfonos o identificaciones (o ninguno: las solicitudes quedan en cola)",
  input: z.object({
    kind: z.enum(["email", "phone", "document"]),
    provider: z.string().trim().min(1).max(80).nullable(),
    // Non-secret options only: provider keys live in Supabase Vault (rule 12).
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  }),
  output: z.object({ kind: z.string(), provider: z.string().nullable() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    // A provider can be chosen once its adapter is registered (registerVerifier at start-up, design §5.16).
    if (input.provider !== null && !registeredVerifiers().includes(input.provider)) {
      throw invalid(`no verifier adapter ${input.provider}`, `El proveedor ${input.provider} no está disponible`);
    }
    await ctx.tx`
      insert into kernel.verifiers (company_id, kind, provider, config)
      values (${ctx.companyId}, ${input.kind}, ${input.provider}, ${ctx.tx.json(input.config)})
      on conflict (company_id, kind) do update set provider = excluded.provider, config = excluded.config`;
    return { kind: input.kind, provider: input.provider };
  },
});

export const SETTINGS_PROCESSES = [companyUpdate, requiredFileSet, requiredFileRemove, verifierSet];
