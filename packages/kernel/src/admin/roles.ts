import { z } from "zod";
import { defineProcess } from "../process/define";
import type { ProcessContext } from "../process/context";
import { ADMIN_FEATURE, companyRole, invalid, requireAdmin } from "./common";

// Roles and who holds them (design §6, rule 13): the admin creates the company's roles with a description and the party
// scope (clientes, proveedores, ambos, ninguno) and assigns them to users from either side, a user's roles or a role's
// users. A new role starts with the baseline grants and every confidential field masked (`kernel.seed_role_defaults`).

const PARTY_SCOPE = z.enum(["ambos", "clientes", "proveedores", "ninguno"]);
const NAME = z.string().trim().min(1, "El nombre es obligatorio").max(60, "Máximo 60 caracteres");
const DESCRIPTION = z.string().trim().max(200, "Máximo 200 caracteres");

async function refuseDuplicateName(ctx: ProcessContext, name: string, exceptId?: string): Promise<void> {
  const [row] = await ctx.tx`
    select 1 from kernel.roles where company_id = ${ctx.companyId} and lower(name) = lower(${name}) and id is distinct from ${exceptId ?? null}`;
  if (row) throw invalid(`a role named ${name} exists`, `Ya existe un rol llamado ${name}`);
}

export const roleCreate = defineProcess({
  id: "kernel.admin.role.create",
  module: "kernel",
  kind: "create",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Crea un rol de la empresa con su descripción y qué terceros ve (clientes, proveedores, ambos o ninguno)",
  input: z.object({ name: NAME, description: DESCRIPTION.default(""), partyScope: PARTY_SCOPE }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    await refuseDuplicateName(ctx, input.name);
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into kernel.roles (company_id, name, description, party_scope, is_system)
      values (${ctx.companyId}, ${input.name}, ${input.description}, ${input.partyScope}, false)
      returning id`;
    await ctx.tx`select kernel.seed_role_defaults(${ctx.companyId}, ${row!.id})`;
    return { id: row!.id };
  },
});

export const roleUpdate = defineProcess({
  id: "kernel.admin.role.update",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Cambia el nombre, la descripción o los terceros que ve un rol de la empresa",
  input: z.object({ roleId: z.uuid(), name: NAME.optional(), description: DESCRIPTION.optional(), partyScope: PARTY_SCOPE.optional() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const role = await companyRole(ctx, input.roleId);
    if (role.isSystemAdmin && ((input.name !== undefined && input.name !== role.name) || (input.partyScope !== undefined && input.partyScope !== "ambos"))) {
      throw invalid("the system admin role keeps its name and sees every party", "El rol admin del sistema conserva su nombre y ve todos los terceros");
    }
    if (input.name !== undefined) await refuseDuplicateName(ctx, input.name, role.id);
    await ctx.tx`
      update kernel.roles set
        name = coalesce(${input.name ?? null}, name),
        description = coalesce(${input.description ?? null}, description),
        party_scope = coalesce(${input.partyScope ?? null}, party_scope)
      where id = ${role.id}`;
    return { id: role.id };
  },
});

/**
 * From either side (design §6): `{ userId, roleIds }` replaces a user's roles, `{ roleId, userIds }` a role's holders.
 * One object (the assistant's tools take an object schema), exactly one of the two shapes.
 */
const userRoleInput = z
  .object({
    userId: z.uuid().optional(),
    roleIds: z.array(z.uuid()).optional(),
    roleId: z.uuid().optional(),
    userIds: z.array(z.uuid()).optional(),
  })
  .refine(
    (v) => (v.userId !== undefined && v.roleIds !== undefined && v.roleId === undefined && v.userIds === undefined) || (v.roleId !== undefined && v.userIds !== undefined && v.userId === undefined && v.roleIds === undefined),
    "Indica un usuario con sus roles o un rol con sus usuarios",
  );

/** The memberships of the company by user id. */
async function memberships(ctx: ProcessContext, userIds: string[]): Promise<Map<string, string>> {
  const rows = await ctx.tx<{ id: string; user_id: string }[]>`
    select id, user_id from kernel.memberships where company_id = ${ctx.companyId} and user_id = any(${userIds}::uuid[])`;
  return new Map(rows.map((r) => [r.user_id, r.id]));
}

/** Who gets which roles: one user's roles, or one role's holders (the two shapes of kernel.admin.user_role.set). */
export type UserRolesChange = { userId: string; roleIds: string[] } | { roleId: string; userIds: string[] };

/**
 * Replaces one user's roles or one role's holders in the active company: the rules of design §6 shared by
 * kernel.admin.user_role.set and kernel.admin.user.update. Every role must be the company's, every user a member; the admin
 * never takes their own admin role away; every member keeps at least one role. The caller (the handler) checked the admin;
 * the writes need the process's audit context (0021/0027 policies of kernel.membership_roles).
 */
export async function setUserRoles(ctx: ProcessContext, input: UserRolesChange): Promise<{ added: number; removed: number }> {
  // The wanted (membership, role) pairs and the scope they replace: one user's roles, or one role's holders.
  let wanted: { membershipId: string; roleId: string }[];
  let scope: { membershipIds: string[]; roleIds: string[] | null };
  if ("userId" in input) {
    const roleIds = [...new Set(input.roleIds)];
    if (roleIds.length === 0) throw invalid("a user needs a role", "Elige al menos un rol");
    for (const roleId of roleIds) await companyRole(ctx, roleId);
    const userId = input.userId;
    const membershipId = (await memberships(ctx, [userId])).get(userId);
    if (!membershipId) throw invalid(`user ${userId} is not a member`, "El usuario no pertenece a la empresa");
    wanted = roleIds.map((roleId) => ({ membershipId, roleId }));
    scope = { membershipIds: [membershipId], roleIds: null };
  } else {
    const roleId = input.roleId;
    await companyRole(ctx, roleId);
    const userIds = [...new Set(input.userIds)];
    const byUser = await memberships(ctx, userIds);
    const outsider = userIds.find((id) => !byUser.has(id));
    if (outsider) throw invalid(`user ${outsider} is not a member`, "Un usuario indicado no pertenece a la empresa");
    wanted = [...byUser.values()].map((membershipId) => ({ membershipId, roleId }));
    const holders = await ctx.tx<{ membership_id: string }[]>`
      select mr.membership_id from kernel.membership_roles mr
      join kernel.memberships m on m.id = mr.membership_id
      where m.company_id = ${ctx.companyId} and mr.role_id = ${roleId}`;
    scope = { membershipIds: [...new Set([...byUser.values(), ...holders.map((h) => h.membership_id)])], roleIds: [roleId] };
  }

  const current = await ctx.tx<{ membership_id: string; role_id: string }[]>`
    select membership_id, role_id from kernel.membership_roles
    where membership_id = any(${scope.membershipIds}::uuid[]) and (${scope.roleIds}::uuid[] is null or role_id = any(${scope.roleIds}::uuid[]))`;
  const key = (p: { membershipId: string; roleId: string }) => `${p.membershipId}:${p.roleId}`;
  const want = new Set(wanted.map(key));
  const have = new Set(current.map((c) => key({ membershipId: c.membership_id, roleId: c.role_id })));
  const toAdd = wanted.filter((p) => !have.has(key(p)));
  const toRemove = current.map((c) => ({ membershipId: c.membership_id, roleId: c.role_id })).filter((p) => !want.has(key(p)));

  // The admin never takes their own admin role away (they would lock the company out of its administration).
  const [own] = await ctx.tx<{ id: string }[]>`select id from kernel.memberships where company_id = ${ctx.companyId} and user_id = ${ctx.userId}`;
  for (const pair of toRemove) {
    if (pair.membershipId === own?.id && (await companyRole(ctx, pair.roleId)).isSystemAdmin) {
      throw invalid("the admin keeps their own admin role", "No puedes quitarte tu propio rol admin");
    }
  }
  for (const pair of toAdd) {
    await ctx.tx`insert into kernel.membership_roles (membership_id, role_id) values (${pair.membershipId}, ${pair.roleId}) on conflict do nothing`;
  }
  for (const pair of toRemove) {
    await ctx.tx`delete from kernel.membership_roles where membership_id = ${pair.membershipId} and role_id = ${pair.roleId}`;
  }
  // Every member keeps at least one role (design §6: a user holds one or more roles).
  const [orphan] = await ctx.tx<{ id: string }[]>`
    select m.id from kernel.memberships m
    where m.id = any(${scope.membershipIds}::uuid[]) and not exists (select 1 from kernel.membership_roles mr where mr.membership_id = m.id)`;
  if (orphan) throw invalid("a user would be left without roles", "Cada usuario debe conservar al menos un rol");
  return { added: toAdd.length, removed: toRemove.length };
}

export const userRoleSet = defineProcess({
  id: "kernel.admin.user_role.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Asigna roles a usuarios: los roles de un usuario o los usuarios de un rol; cada usuario conserva al menos un rol",
  input: userRoleInput,
  output: z.object({ added: z.number(), removed: z.number() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    return setUserRoles(ctx, input.userId !== undefined ? { userId: input.userId, roleIds: input.roleIds! } : { roleId: input.roleId!, userIds: input.userIds! });
  },
});

export const ROLE_PROCESSES = [roleCreate, roleUpdate, userRoleSet];
