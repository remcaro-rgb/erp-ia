import { z } from "zod";
import type { Tx } from "../db/client";
import type { ProcessContext } from "../process/context";
import type { Registry } from "../registry";
import { defineProcess } from "../process/define";
import { ADMIN_FEATURE, companyRole, invalid, refuseSystemAdmin, requireAdmin, type CompanyRole } from "./common";
import { matrixProcesses, type MatrixProcess } from "./matrix";
import { moduleStates } from "./modules-state";

// The permission matrix, field visibility and sensitive processes (design §6, rules 13–15). Every change is the admin's,
// confirmed with the step-up, and audited by the pipeline; the row triggers record the before/after of each grant.

const PROCESS_ID = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "Identificador de proceso inválido");

/** One cell of the permission matrix: the role, the process and whether the role may run it. */
export const permissionChange = z.object({ roleId: z.uuid(), processId: PROCESS_ID, allowed: z.boolean() });
export type PermissionChange = z.infer<typeof permissionChange>;

/** The company's role by id, read once per batch. */
export type RoleLookup = (roleId: string) => Promise<CompanyRole>;

/** Reads each role of the active company once (a batch names the same roles many times). */
export function roleLookup(ctx: ProcessContext): RoleLookup {
  const seen = new Map<string, Promise<CompanyRole>>();
  return (roleId) => {
    let role = seen.get(roleId);
    if (!role) seen.set(roleId, (role = companyRole(ctx, roleId)));
    return role;
  };
}

/**
 * Refuses (`invalid_input`) a cell the matrix may not change: a role of another company, the system admin role, an
 * unknown process, or an administration process given to another role. Shared by permission.set and set_many, so the
 * single and the batch paths cannot drift.
 */
export async function checkPermissionChange(ctx: ProcessContext, change: PermissionChange, roleOf: RoleLookup = roleLookup(ctx)): Promise<void> {
  refuseSystemAdmin(await roleOf(change.roleId));
  const process = ctx.registry.processes().find((p) => p.id === change.processId);
  if (!process) throw invalid(`unknown process ${change.processId}`, `El proceso ${change.processId} no existe`);
  // Administration stays with the admin role: it is never granted to another role (the handlers check it too).
  if (change.allowed && process.feature === ADMIN_FEATURE) {
    throw invalid(`${change.processId} is an administration process`, "Los procesos de administración son solo del rol admin");
  }
}

/** Stores checked cells (one statement; the row trigger audits each grant). */
export async function writePermissions(ctx: ProcessContext, changes: PermissionChange[]): Promise<void> {
  const rows = changes.map((c) => ({ company_id: ctx.companyId, role_id: c.roleId, process_id: c.processId, allowed: c.allowed }));
  await ctx.tx`
    insert into kernel.process_permissions ${ctx.tx(rows, "company_id", "role_id", "process_id", "allowed")}
    on conflict (company_id, role_id, process_id) do update set allowed = excluded.allowed`;
}

export const permissionSet = defineProcess({
  id: "kernel.admin.permission.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Permite o niega a un rol ejecutar un proceso (matriz de permisos)",
  input: permissionChange,
  output: z.object({ roleId: z.string(), processId: z.string(), allowed: z.boolean() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    await checkPermissionChange(ctx, input);
    await writePermissions(ctx, [input]);
    return input;
  },
});

const matrixOutput = z.object({
  roles: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), isSystemAdmin: z.boolean(), partyScope: z.string() })),
  processes: z.array(
    z.object({ id: z.string(), module: z.string(), kind: z.string(), entity: z.string(), entityLabel: z.string(), stepUp: z.boolean(), admin: z.boolean() }),
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
    from kernel.v_roles where company_id = ${companyId} order by is_system desc, created_at, id`;
  const rows = await tx<{ role_id: string; process_id: string }[]>`
    select role_id, process_id from kernel.v_process_permissions where company_id = ${companyId} and allowed`;
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
  // Reading the matrix changes nothing: no step-up (ruling 2026-10-28); the changes ask for it.
  description: "Consulta la matriz de permisos: procesos de los módulos activos por rol, con la entidad de cada proceso",
  input: z.object({}),
  output: matrixOutput,
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return readPermissionMatrix(ctx.tx, ctx.registry, ctx.companyId);
  },
});

/** One cell of the field visibility matrix: the role, the entity's field and how the role sees it (rule 14). */
export const fieldPermissionChange = z.object({ roleId: z.uuid(), entity: z.string().min(1), field: z.string().min(1), mode: z.enum(["visible", "masked", "hidden"]) });
export type FieldPermissionChange = z.infer<typeof fieldPermissionChange>;

/** Refuses a cell of another company's role, of the system admin role or of an unknown field (single and batch paths). */
export async function checkFieldPermissionChange(ctx: ProcessContext, change: FieldPermissionChange, roleOf: RoleLookup = roleLookup(ctx)): Promise<void> {
  refuseSystemAdmin(await roleOf(change.roleId));
  const entity = ctx.registry.entities().find((e) => e.id === change.entity);
  if (!entity || !entity.fields.some((f) => f.name === change.field)) {
    throw invalid(`unknown field ${change.entity}.${change.field}`, `El campo ${change.entity}.${change.field} no existe`);
  }
}

/** Stores checked cells. An explicit row also for `visible`: the confidential defaults never mask again what the admin chose to show. */
export async function writeFieldPermissions(ctx: ProcessContext, changes: FieldPermissionChange[]): Promise<void> {
  const rows = changes.map((c) => ({ company_id: ctx.companyId, role_id: c.roleId, entity: c.entity, field: c.field, mode: c.mode }));
  await ctx.tx`
    insert into kernel.field_permissions ${ctx.tx(rows, "company_id", "role_id", "entity", "field", "mode")}
    on conflict (company_id, role_id, entity, field) do update set mode = excluded.mode`;
}

export const fieldPermissionSet = defineProcess({
  id: "kernel.admin.field_permission.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Define si un rol ve un campo de una entidad visible, enmascarado u oculto (en grids, formularios, exportaciones y asistente)",
  input: fieldPermissionChange,
  output: z.object({ roleId: z.string(), entity: z.string(), field: z.string(), mode: z.string() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    await checkFieldPermissionChange(ctx, input);
    await writeFieldPermissions(ctx, [input]);
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
