import { registeredEntity } from "../attachments/guards";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import type { ProcessContext } from "../process/context";
import { entityInput, idOutput, listOutput, removeInput, setInput } from "./schemas";
import { loadCustomFields } from "./store";
import { canView, roleIn } from "./visibility";

// Custom fields (Datos adicionales, design §5.14). The admin defines them with set / remove; every
// member reads the definitions with list, which also says what the caller's own roles may do with each.

const FEATURE = "kernel.custom_fields";

async function requireAdmin(ctx: ProcessContext): Promise<void> {
  const [row] = await ctx.tx<{ admin: boolean }[]>`select kernel.is_company_admin() as admin`;
  if (!row?.admin) throw new ProcessError("forbidden", "only the company admin defines custom fields");
}

export const customFieldSet = defineProcess({
  id: "kernel.custom_field.set",
  module: "kernel",
  kind: "update",
  feature: FEATURE,
  description: "Define o cambia un dato adicional de una entidad (tipo, longitud, obligatorio, lista y roles que pueden ingresar, editar y ver)",
  input: setInput,
  output: idOutput,
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const entity = registeredEntity(ctx, input.entity);
    const roleIds = [...new Set([...input.rolesEnter, ...input.rolesEdit, ...input.rolesView])];
    if (roleIds.length > 0) {
      const [found] = await ctx.tx<{ n: string }[]>`
        select count(*) as n from kernel.roles where company_id = ${ctx.companyId} and id = any(${roleIds}::uuid[])`;
      if (Number(found!.n) !== roleIds.length) {
        throw new ProcessError("invalid_input", "a role does not belong to the company", { details: ["Un rol indicado no pertenece a la empresa"] });
      }
    }
    const options = input.type === "list" ? [...new Set(input.options)] : null;
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into kernel.custom_fields (company_id, entity, key, label, type, max_length, required, options, roles_enter, roles_edit, roles_view)
      values (${ctx.companyId}, ${entity.id}, ${input.key}, ${input.label}, ${input.type}, ${input.maxLength ?? null}, ${input.required},
              ${options}::text[], ${input.rolesEnter}::uuid[], ${input.rolesEdit}::uuid[], ${input.rolesView}::uuid[])
      on conflict (company_id, entity, key) do update set
        label = excluded.label, type = excluded.type, max_length = excluded.max_length, required = excluded.required,
        options = excluded.options, roles_enter = excluded.roles_enter, roles_edit = excluded.roles_edit, roles_view = excluded.roles_view
      returning id`;
    return { id: row!.id };
  },
});

export const customFieldRemove = defineProcess({
  id: "kernel.custom_field.remove",
  module: "kernel",
  kind: "delete",
  feature: FEATURE,
  description: "Quita la definición de un dato adicional; los valores ya guardados se conservan pero nadie los ve",
  input: removeInput,
  output: idOutput,
  handler: async (ctx, { entity, key }) => {
    await requireAdmin(ctx);
    const rows = await ctx.tx<{ id: string }[]>`delete from kernel.custom_fields where entity = ${entity} and key = ${key} returning id`;
    if (rows.length === 0) throw new ProcessError("not_found", `custom field ${entity}.${key} not found`);
    return { id: rows[0]!.id };
  },
});

export const customFieldList = defineProcess({
  id: "kernel.custom_field.list",
  module: "kernel",
  kind: "consult",
  feature: FEATURE,
  description: "Lista los datos adicionales definidos para una entidad y lo que el rol del usuario puede hacer con cada uno",
  input: entityInput,
  output: listOutput,
  handler: async (ctx, { entity }) => {
    const known = registeredEntity(ctx, entity);
    const [admin] = await ctx.tx<{ admin: boolean }[]>`select kernel.is_company_admin() as admin`;
    const caller = { roleIds: ctx.roleIds };
    return (await loadCustomFields(ctx.tx, known.id)).map((def) => ({
      id: def.id,
      entity: def.entity,
      key: def.key,
      label: def.label,
      type: def.type,
      maxLength: def.maxLength,
      required: def.required,
      // The values of a list the caller may not view are as private as the field's value.
      options: def.options && (admin?.admin || canView(def, caller)) ? [...def.options] : null,
      canEnter: roleIn(caller, def.rolesEnter),
      canEdit: roleIn(caller, def.rolesEdit),
      canView: canView(def, caller),
      rolesEnter: admin?.admin ? [...def.rolesEnter] : null,
      rolesEdit: admin?.admin ? [...def.rolesEdit] : null,
      rolesView: admin?.admin ? [...def.rolesView] : null,
    }));
  },
});

export const CUSTOM_FIELD_PROCESSES = [customFieldSet, customFieldRemove, customFieldList];
