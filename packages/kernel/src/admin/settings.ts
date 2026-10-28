import { z } from "zod";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
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

export const companyUpdate = defineProcess({
  id: "kernel.admin.company.update",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Cambia la razón social, el nombre comercial o la zona horaria de la empresa activa",
  input: z
    .object({
      legalName: z.string().trim().min(1, "La razón social es obligatoria").max(450, "Máximo 450 caracteres").optional(),
      tradeName: z.string().trim().max(450, "Máximo 450 caracteres").nullable().optional(),
      timezone: z.string().refine(timezoneValid, "Zona horaria desconocida (por ejemplo America/Bogota)").optional(),
    })
    .refine((v) => Object.values(v).some((x) => x !== undefined), "Indica al menos un dato"),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const rows = await ctx.tx<{ id: string }[]>`
      update kernel.companies set
        legal_name = coalesce(${input.legalName ?? null}, legal_name),
        trade_name = case when ${input.tradeName === undefined} then trade_name else nullif(${input.tradeName ?? ""}, '') end,
        timezone = coalesce(${input.timezone ?? null}, timezone)
      where id = ${ctx.companyId}
      returning id`;
    if (rows.length === 0) throw new ProcessError("not_found", `company ${ctx.companyId} not found`);
    return { id: rows[0]!.id };
  },
});

const CONDITION = z.enum(["co", "co-juridica", "proveedor", "cliente"]).nullable();

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
      on conflict (company_id, entity, lower(btrim(tag))) do update set
        tag = excluded.tag, kind = excluded.kind, required = excluded.required, condition = excluded.condition, description = excluded.description
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
    await ctx.tx`
      insert into kernel.verifiers (company_id, kind, provider, config)
      values (${ctx.companyId}, ${input.kind}, ${input.provider}, ${ctx.tx.json(input.config)})
      on conflict (company_id, kind) do update set provider = excluded.provider, config = excluded.config`;
    return { kind: input.kind, provider: input.provider };
  },
});

export const SETTINGS_PROCESSES = [companyUpdate, requiredFileSet, requiredFileRemove, verifierSet];
