import { z } from "zod";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { defineEntity } from "../registry/entities";
import { USER_ENTITY } from "../registry/href";

// The users of the company as a registry entity (design §22.15, rule 21): every reference to a user (a ticket's
// reporter, an audit actor) names them by their full name and links to their page under Administración › Usuarios.
// `kernel.user` reads `kernel.v_users` (migration 0026): the members of the caller's active company, each field under
// the caller's field visibility, the mobile (confidential) only for a user of the caller's organization alone. Its grid,
// its lookups, the label of a reference and `kernel.user.consult` read the same view. Read only: users are created and
// changed by the admin processes (kernel.admin.user.*), never through this entity.

export const USERS_FEATURE = "kernel.users";

export const userEntity = defineEntity({
  id: USER_ENTITY,
  module: "kernel",
  schema: "kernel",
  table: "users",
  label: "entity.kernel.user",
  displayField: "full_name",
  defaultSort: { field: "full_name", dir: "asc" },
  // A user's page is under Administración › Usuarios (`recordHref`).
  recordPage: true,
  fields: [
    { name: "full_name", type: "text", label: "field.kernel.user.full_name", searchable: true },
    { name: "email", type: "text", label: "field.kernel.user.email", searchable: true },
    { name: "locale", type: "text", label: "field.kernel.user.locale" },
    { name: "mobile", type: "text", label: "field.kernel.user.mobile", sensitivity: "confidential" },
    { name: "created_at", type: "datetime", label: "field.kernel.user.created_at" },
  ],
});

export const userConsult = defineProcess({
  id: "kernel.user.consult",
  module: "kernel",
  kind: "consult",
  feature: USERS_FEATURE,
  description: "Consulta un usuario de la empresa (nombre, correo, idioma y celular) con los campos que el rol puede ver",
  input: z.object({ id: z.uuid() }),
  output: z.object({
    id: z.string(),
    full_name: z.string().nullable(),
    email: z.string().nullable(),
    locale: z.string().nullable(),
    mobile: z.string().nullable(),
    created_at: z.union([z.date(), z.string()]).nullable(),
  }),
  handler: async (ctx, { id }) => {
    const [row] = await ctx.tx<{ id: string; full_name: string | null; email: string | null; locale: string | null; mobile: string | null; created_at: Date | null }[]>`
      select id, full_name, email, locale, mobile, created_at from kernel.v_users where id = ${id}`;
    if (!row) throw new ProcessError("not_found", `kernel.user ${id} not found`);
    return { ...row };
  },
});

export const USER_PROCESSES = [userConsult];
