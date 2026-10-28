import { z } from "zod";
import type { Tx } from "../db/client";
import type { Registry } from "../registry";
import { defineProcess } from "../process/define";
import { ADMIN_FEATURE, companyRole, invalid, refuseSystemAdmin, requireAdmin } from "./common";
import { matrixProcesses, type MatrixProcess } from "./matrix";
import { moduleStates } from "./modules-state";

// The permission matrix, field visibility and sensitive processes (design §6, rules 13–15). Every change is the admin's,
// confirmed with the step-up, and audited by the pipeline; the row triggers record the before/after of each grant.

const PROCESS_ID = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "Identificador de proceso inválido");

export const permissionSet = defineProcess({
  id: "kernel.admin.permission.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Permite o niega a un rol ejecutar un proceso (matriz de permisos)",
  input: z.object({ roleId: z.uuid(), processId: PROCESS_ID, allowed: z.boolean() }),
  output: z.object({ roleId: z.string(), processId: z.string(), allowed: z.boolean() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    refuseSystemAdmin(await companyRole(ctx, input.roleId));
    if (!ctx.registry.processes().some((p) => p.id === input.processId)) {
      throw invalid(`unknown process ${input.processId}`, `El proceso ${input.processId} no existe`);
    }
    await ctx.tx`
      insert into kernel.process_permissions (company_id, role_id, process_id, allowed)
      values (${ctx.companyId}, ${input.roleId}, ${input.processId}, ${input.allowed})
      on conflict (company_id, role_id, process_id) do update set allowed = excluded.allowed`;
    return input;
  },
});

const matrixOutput = z.object({
  roles: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), isSystemAdmin: z.boolean(), partyScope: z.string() })),
  processes: z.array(
    z.object({ id: z.string(), module: z.string(), kind: z.string(), entity: z.string(), entityLabel: z.string(), stepUp: z.boolean() }),
  ),
  /** Process ids each role (by id) may run. */
  grants: z.record(z.string(), z.array(z.string())),
});

export type PermissionMatrix = z.infer<typeof matrixOutput>;

/**
 * The company's matrix read in `tx` as the caller (company RLS): its roles, the processes of the modules it uses with
 * their entity, and what each role may run. The consult process and the permissions page share it.
 */
export async function readPermissionMatrix(tx: Tx, registry: Registry, companyId: string): Promise<PermissionMatrix> {
  const usable = new Set((await moduleStates(tx, registry)).filter((m) => m.enabled).map((m) => m.id));
  const roles = await tx<{ id: string; name: string; description: string; system_admin: boolean; party_scope: string }[]>`
    select id, name, description, is_system and name = 'admin' as system_admin, party_scope
    from kernel.roles where company_id = ${companyId} order by is_system desc, created_at, id`;
  const rows = await tx<{ role_id: string; process_id: string }[]>`
    select role_id, process_id from kernel.process_permissions where company_id = ${companyId} and allowed`;
  const grants: Record<string, string[]> = Object.fromEntries(roles.map((r) => [r.id, [] as string[]]));
  for (const row of rows) grants[row.role_id]?.push(row.process_id);
  const processes: MatrixProcess[] = matrixProcesses(registry, usable);
  return {
    roles: roles.map((r) => ({ id: r.id, name: r.name, description: r.description, isSystemAdmin: r.system_admin, partyScope: r.party_scope })),
    processes,
    grants,
  };
}

export const permissionMatrix = defineProcess({
  id: "kernel.admin.permission.matrix",
  module: "kernel",
  kind: "consult",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Consulta la matriz de permisos: procesos de los módulos activos por rol, con la entidad de cada proceso",
  input: z.object({}),
  output: matrixOutput,
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return readPermissionMatrix(ctx.tx, ctx.registry, ctx.companyId);
  },
});

export const fieldPermissionSet = defineProcess({
  id: "kernel.admin.field_permission.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Define si un rol ve un campo de una entidad visible, enmascarado u oculto (en grids, formularios, exportaciones y asistente)",
  input: z.object({ roleId: z.uuid(), entity: z.string().min(1), field: z.string().min(1), mode: z.enum(["visible", "masked", "hidden"]) }),
  output: z.object({ roleId: z.string(), entity: z.string(), field: z.string(), mode: z.string() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    refuseSystemAdmin(await companyRole(ctx, input.roleId));
    const entity = ctx.registry.entities().find((e) => e.id === input.entity);
    if (!entity || !entity.fields.some((f) => f.name === input.field)) {
      throw invalid(`unknown field ${input.entity}.${input.field}`, `El campo ${input.entity}.${input.field} no existe`);
    }
    // An explicit row also for `visible`: the confidential defaults never mask again what the admin chose to show.
    await ctx.tx`
      insert into kernel.field_permissions (company_id, role_id, entity, field, mode)
      values (${ctx.companyId}, ${input.roleId}, ${input.entity}, ${input.field}, ${input.mode})
      on conflict (company_id, role_id, entity, field) do update set mode = excluded.mode`;
    return input;
  },
});

export const sensitiveProcessSet = defineProcess({
  id: "kernel.admin.sensitive_process.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Exige o deja de exigir la verificación en dos pasos (2FA) para ejecutar un proceso en la empresa",
  input: z.object({ processId: PROCESS_ID, sensitive: z.boolean() }),
  output: z.object({ processId: z.string(), sensitive: z.boolean() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const process = ctx.registry.processes().find((p) => p.id === input.processId);
    if (!process) throw invalid(`unknown process ${input.processId}`, `El proceso ${input.processId} no existe`);
    if (!input.sensitive && process.sensitivity === "step-up") {
      // Rule 15: the admin raises sensitivity, never lowers what a process demands by definition.
      throw invalid(`${input.processId} always requires the step-up`, "Este proceso siempre exige la verificación en dos pasos");
    }
    if (input.sensitive) {
      await ctx.tx`
        insert into kernel.sensitive_processes (company_id, process_id, mode) values (${ctx.companyId}, ${input.processId}, 'self_2fa')
        on conflict (company_id, process_id) do nothing`;
    } else {
      await ctx.tx`delete from kernel.sensitive_processes where company_id = ${ctx.companyId} and process_id = ${input.processId}`;
    }
    return input;
  },
});

export const PERMISSION_PROCESSES = [permissionSet, permissionMatrix, fieldPermissionSet, sensitiveProcessSet];
