import { defineProcess } from "@erp/kernel";
import { z } from "zod";
import { invalid, requireAdmin } from "./common";
import { id } from "./schemas";

// Security by account (accounting design §4.15, §5.13, §6): which roles and users may see and post to a restricted account.
// Only the company admin edits it, under step-up; the enforcement lives in the SQL functions of migration 0031.

const grant = z.object({ subjectKind: z.enum(["role", "user"]), subjectId: id, canView: z.boolean(), canPost: z.boolean() }).strict();

interface GrantRow {
  subject_kind: "role" | "user";
  subject_id: string;
  can_view: boolean;
  can_post: boolean;
  is_active: boolean;
}
const shape = (g: GrantRow) => ({ subjectKind: g.subject_kind, subjectId: g.subject_id, canView: g.can_view, canPost: g.can_post, isActive: g.is_active });

export const accountPermissionUpdate = defineProcess({
  id: "accounting.account_permission.update",
  module: "accounting",
  kind: "update",
  feature: "accounting.ledger",
  sensitivity: "step-up",
  description: "Abre o restringe una cuenta (y sus descendientes) y reemplaza quién puede verla y contabilizar en ella; solo el administrador",
  input: z.object({ accountId: id, access: z.enum(["open", "restricted"]), grants: z.array(grant).max(200) }).strict(),
  output: z.object({ id: z.string(), access: z.string(), grants: z.number() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const [account] = await ctx.tx<{ code: string; access: string }[]>`
      select code, access from accounting.accounts where id = ${input.accountId} and company_id = ${ctx.companyId} for update`;
    if (!account) throw invalid(`account ${input.accountId} not found`, "La cuenta indicada no existe");

    const wanted = new Map<string, { kind: "role" | "user"; id: string; view: boolean; post: boolean }>();
    for (const g of input.grants) {
      const key = `${g.subjectKind}|${g.subjectId}`;
      if (wanted.has(key)) throw invalid(`repeated subject ${key}`, "Un rol o usuario aparece más de una vez en los permisos");
      wanted.set(key, { kind: g.subjectKind, id: g.subjectId, view: g.canView || g.canPost, post: g.canPost });
    }
    // Every subject belongs to the company: a role of it, or a user with a membership in it.
    for (const subject of wanted.values()) {
      const [found] =
        subject.kind === "role"
          ? await ctx.tx`select 1 as ok from kernel.roles where id = ${subject.id} and company_id = ${ctx.companyId}`
          : await ctx.tx`select 1 as ok from kernel.memberships where user_id = ${subject.id} and company_id = ${ctx.companyId}`;
      if (!found) throw invalid(`${subject.kind} ${subject.id} is not of the company`, `El ${subject.kind === "role" ? "rol" : "usuario"} indicado no pertenece a la empresa`);
    }

    const before = await ctx.tx<GrantRow[]>`
      select subject_kind, subject_id, can_view, can_post, is_active from accounting.account_permissions
      where company_id = ${ctx.companyId} and account_id = ${input.accountId} order by subject_kind, subject_id`;
    const existing = new Map(before.map((g) => [`${g.subject_kind}|${g.subject_id}`, g]));
    for (const [key, g] of existing) {
      if (!wanted.has(key)) await ctx.tx`delete from accounting.account_permissions where company_id = ${ctx.companyId} and account_id = ${input.accountId} and subject_kind = ${g.subject_kind} and subject_id = ${g.subject_id}`;
    }
    for (const [key, w] of wanted) {
      const row = existing.get(key);
      if (row) {
        if (row.can_view !== w.view || row.can_post !== w.post || !row.is_active) {
          await ctx.tx`update accounting.account_permissions set can_view = ${w.view}, can_post = ${w.post}, is_active = true
                       where company_id = ${ctx.companyId} and account_id = ${input.accountId} and subject_kind = ${w.kind} and subject_id = ${w.id}`;
        }
      } else {
        await ctx.tx`insert into accounting.account_permissions (company_id, account_id, subject_kind, subject_id, can_view, can_post)
                     values (${ctx.companyId}, ${input.accountId}, ${w.kind}, ${w.id}, ${w.view}, ${w.post})`;
      }
    }
    if (account.access !== input.access) await ctx.tx`update accounting.accounts set access = ${input.access} where id = ${input.accountId}`;

    const after = [...wanted.values()].map((w) => ({ subjectKind: w.kind, subjectId: w.id, canView: w.view, canPost: w.post, isActive: true }));
    await ctx.audit({
      entity: "accounting.account",
      rowId: input.accountId,
      action: "update",
      diff: { access: { old: account.access, new: input.access }, grants: { old: before.map(shape), new: after } },
    });
    return { id: input.accountId, access: input.access, grants: after.length };
  },
});

const consultInput = z.union([
  z.object({ accountId: id }).strict(),
  z.object({ subjectKind: z.enum(["role", "user"]), subjectId: id }).strict(),
]);

export const accountPermissionConsult = defineProcess({
  id: "accounting.account_permission.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Consulta la seguridad de una cuenta (abierta o restringida, de dónde la hereda y sus permisos) o las cuentas a las que un rol o usuario tiene permiso; solo el administrador",
  input: consultInput,
  output: z.looseObject({ grants: z.array(z.looseObject({})) }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    if ("accountId" in input) {
      const [account] = await ctx.tx<{ access: string }[]>`select access from accounting.accounts where id = ${input.accountId} and company_id = ${ctx.companyId}`;
      if (!account) throw invalid(`account ${input.accountId} not found`, "La cuenta indicada no existe");
      const [root] = await ctx.tx<{ root: string | null }[]>`select accounting.restricted_root(${input.accountId}) as root`;
      const grants = await ctx.tx<{ id: string; subject_kind: string; subject_id: string; name: string | null; can_view: boolean; can_post: boolean; is_active: boolean }[]>`
        select g.id, g.subject_kind, g.subject_id, coalesce(r.name, u.full_name) as name, g.can_view, g.can_post, g.is_active
        from accounting.account_permissions g
        left join kernel.roles r on g.subject_kind = 'role' and r.id = g.subject_id
        left join kernel.v_users u on g.subject_kind = 'user' and u.id = g.subject_id
        where g.company_id = ${ctx.companyId} and g.account_id = ${input.accountId}
        order by g.subject_kind, name`;
      return {
        access: account.access,
        effective: root!.root ? "restricted" : "open",
        ...(root!.root && root!.root !== input.accountId ? { inheritedFrom: root!.root } : {}),
        grants: grants.map((g) => ({ id: g.id, subjectKind: g.subject_kind, subjectId: g.subject_id, subjectName: g.name, canView: g.can_view, canPost: g.can_post, isActive: g.is_active })),
      };
    }
    const grants = await ctx.tx<{ account_id: string; code: string; name: string; can_view: boolean; can_post: boolean; is_active: boolean }[]>`
      select g.account_id, a.code, a.name, g.can_view, g.can_post, g.is_active
      from accounting.account_permissions g join accounting.accounts a on a.id = g.account_id
      where g.company_id = ${ctx.companyId} and g.subject_kind = ${input.subjectKind} and g.subject_id = ${input.subjectId}
      order by a.code`;
    return { grants: grants.map((g) => ({ accountId: g.account_id, accountCode: g.code, accountName: g.name, canView: g.can_view, canPost: g.can_post, isActive: g.is_active })) };
  },
});

export const PERMISSION_PROCESSES = [accountPermissionUpdate, accountPermissionConsult];
