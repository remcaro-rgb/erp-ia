import { z } from "zod";
import { ADMIN_FEATURE, companyRole, invalid, requireAdmin } from "../admin/common";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import type { RecordRight } from "../process/run";
import { IDENTIFIER } from "../registry/fields";

// Record-level access (entity types spec 2026-11-02 §9.1, D7, D12): the admin decides which roles and users may read, use, modify,
// delete or void one record of a maestro or documento. kernel.record_access.set replaces the record's whole set of rules in one
// audited run (the process audit plus a row audit entry for every rule removed and added: the append-only history of the rules).
// An empty set makes the record unrestricted again. Rules only narrow: they never give a role a process it may not run, and never
// apply to company admins. Company-admin only, step-up (rule 15).

/** The rights each typed entity type has (spec §2.2, §2.3). */
const RIGHTS: Record<"maestro" | "documento", readonly RecordRight[]> = {
  maestro: ["read", "use", "modify", "delete"],
  documento: ["read", "modify", "void"],
};
const ALL_RIGHTS = ["read", "use", "modify", "delete", "void"] as const satisfies readonly RecordRight[];

/** Spanish labels of the rights in the refusals (the admin screen shows them). */
const RIGHT_LABEL: Record<RecordRight, string> = { read: "ver", use: "usar", modify: "modificar", delete: "eliminar", void: "anular" };

const grant = z.object({
  roleId: z.uuid().optional(),
  userId: z.uuid().optional(),
  rights: z.array(z.enum(ALL_RIGHTS)).min(1, "Indica al menos un permiso").max(ALL_RIGHTS.length),
});
export type RecordAccessGrant = z.infer<typeof grant>;

export const recordAccessSet = defineProcess({
  id: "kernel.record_access.set",
  module: "kernel",
  kind: "update",
  recordAccess: "none",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description:
    "Define quién puede ver, usar, modificar, eliminar o anular un registro de un maestro o documento (por rol o por usuario); reemplaza las reglas del registro y, sin reglas, el registro vuelve a seguir solo los permisos del rol. Los administradores no se restringen",
  input: z.object({ entity: z.string().min(1), recordId: z.uuid(), grants: z.array(grant).max(200, "Máximo 200 reglas por registro") }),
  output: z.object({ entity: z.string(), recordId: z.string(), grants: z.number().int() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const entity = ctx.registry.entities().find((e) => e.id === input.entity);
    if (!entity) throw invalid(`unknown entity ${input.entity}`, `La entidad ${input.entity} no existe`);
    if (entity.kind === "query" || (entity.entityType !== "maestro" && entity.entityType !== "documento")) {
      throw invalid(`entity ${input.entity} is ${entity.entityType ?? entity.kind}`, `La entidad ${input.entity} no es un maestro ni un documento`);
    }
    const type = entity.entityType;
    for (const part of [entity.schema, entity.table]) if (!IDENTIFIER.test(part)) throw new Error(`entity ${entity.id}: invalid identifier "${part}"`);
    // The admin reads every record of the company (admins are never narrowed), so a record they do not see does not exist.
    const [exists] = await ctx.tx.unsafe<{ found: boolean }[]>(`select exists (select 1 from ${entity.schema}.${entity.table} where id = $1) as found`, [input.recordId]);
    if (!exists?.found) throw new ProcessError("not_found", `${entity.id} ${input.recordId} not found`);

    const seen = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    for (const g of input.grants) {
      if ((g.roleId === undefined) === (g.userId === undefined)) throw invalid("a grant names exactly one grantee", "Cada regla es para un rol o para un usuario, no ambos");
      const key = g.roleId ? `role:${g.roleId}` : `user:${g.userId}`;
      if (seen.has(key)) throw invalid(`grantee ${key} is listed twice`, "Un rol o un usuario aparece en más de una regla");
      seen.add(key);
      const rights = new Set(g.rights);
      const foreign = [...rights].filter((r) => !RIGHTS[type].includes(r));
      if (foreign.length > 0) {
        throw invalid(`${type} ${entity.id} has no right ${foreign.join(", ")}`, `Un ${type} no tiene el permiso ${foreign.map((r) => RIGHT_LABEL[r]).join(", ")}`);
      }
      if (!rights.has("read")) throw invalid("every grant includes read", "Cada regla incluye el permiso de ver el registro");
      if (g.roleId) await companyRole(ctx, g.roleId);
      if (g.userId) {
        // An active member only (review M3): a deactivated membership keeps its history, never a new grant.
        const [member] = await ctx.tx`select 1 from kernel.memberships where user_id = ${g.userId} and company_id = ${ctx.companyId} and is_active`;
        if (!member) throw invalid(`user ${g.userId} is not a member of the company`, "El usuario no pertenece a la empresa o está inactivo");
      }
      rows.push({
        company_id: ctx.companyId,
        entity: entity.id,
        record_id: input.recordId,
        grantee_role_id: g.roleId ?? null,
        grantee_user_id: g.userId ?? null,
        can_read: true,
        can_use: rights.has("use"),
        can_modify: rights.has("modify"),
        can_delete: rights.has("delete"),
        can_void: rights.has("void"),
      });
    }
    // Replaced, never edited: the old rules are deleted and the new ones inserted; the row audit keeps both.
    await ctx.tx`delete from kernel.record_access where company_id = ${ctx.companyId} and entity = ${entity.id} and record_id = ${input.recordId}`;
    if (rows.length > 0) await ctx.tx`insert into kernel.record_access ${ctx.tx(rows)}`;
    return { entity: entity.id, recordId: input.recordId, grants: rows.length };
  },
});

export const RECORD_ACCESS_PROCESSES = [recordAccessSet];
