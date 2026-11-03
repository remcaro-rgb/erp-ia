import { ACCOUNT_ROLES, defineProcess, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { invalid } from "./common";
import { id } from "./schemas";

// Role mappings (accounting design §4.2, §6): the account each posting role, optionally narrowed by a dimension, resolves to.
// Editing them changes where every future posting lands, so the update runs under step-up.

const dimension = z.string().trim().regex(/^[a-z_]+:\S.*$/, "La dimensión lleva la forma tipo:valor, por ejemplo tax:IVA19").max(120);

/** Every role a rule may name: the kernel catalogue plus the roles the loaded modules add. */
export function knownRoles(ctx: Pick<ProcessContext, "registry">): string[] {
  return [...new Set<string>([...ACCOUNT_ROLES, ...ctx.registry.modules().flatMap((m) => m.accountRoles ?? [])])];
}

/**
 * The account a role resolves to for a dimension (design §4.2): the `(role, dimension)` mapping, else `(role, null)`, else null.
 * An explicit account in a rule line, which comes first, is the caller's concern.
 */
export async function resolveRoleAccount(ctx: Pick<ProcessContext, "tx" | "companyId">, role: string, dimension?: string): Promise<{ accountId: string; code: string } | null> {
  const [row] = await ctx.tx<{ account_id: string; code: string }[]>`
    select m.account_id, a.code
    from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
    where m.company_id = ${ctx.companyId} and m.role = ${role} and (m.dimension is null or m.dimension = ${dimension ?? null})
    order by (m.dimension is null) limit 1`;
  return row ? { accountId: row.account_id, code: row.code } : null;
}

export const accountRoleMappingUpdate = defineProcess({
  id: "accounting.account_role_mapping.update",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.posting",
  sensitivity: "step-up",
  description: "Cambia a qué cuenta va cada rol contable (opcionalmente por dimensión, como tax:IVA19 o category:<id>); una cuenta nula quita el mapeo",
  input: z.object({ mappings: z.array(z.object({ role: z.string().trim().min(1), dimension: dimension.nullable().optional(), accountId: id.nullable() }).strict()).min(1).max(200) }).strict(),
  output: z.object({ upserted: z.number(), removed: z.number() }),
  handler: async (ctx, { mappings }) => {
    const roles = new Set(knownRoles(ctx));
    const seen = new Set<string>();
    for (const m of mappings) {
      if (!roles.has(m.role)) throw invalid(`unknown role ${m.role}`, `El rol contable ${m.role} no existe`);
      const key = `${m.role}|${m.dimension ?? ""}`;
      if (seen.has(key)) throw invalid(`repeated mapping ${key}`, `El rol ${m.role}${m.dimension ? ` (${m.dimension})` : ""} aparece más de una vez`);
      seen.add(key);
    }
    let upserted = 0;
    let removed = 0;
    for (const m of mappings) {
      const [existing] = await ctx.tx<{ id: string }[]>`
        select id from accounting.account_role_mappings
        where company_id = ${ctx.companyId} and role = ${m.role} and coalesce(dimension, '') = ${m.dimension ?? ""} for update`;
      if (m.accountId === null) {
        if (existing) {
          await ctx.tx`delete from accounting.account_role_mappings where id = ${existing.id}`;
          removed++;
        }
        continue;
      }
      const [account] = await ctx.tx<{ code: string; allows_movement: boolean; is_active: boolean }[]>`
        select code, allows_movement, is_active from accounting.accounts where id = ${m.accountId} and company_id = ${ctx.companyId}`;
      if (!account) throw invalid(`account ${m.accountId} not found`, "La cuenta indicada no existe");
      if (!account.allows_movement) throw invalid(`account ${account.code} takes no movements`, `La cuenta ${account.code} no recibe movimientos: elige una subcuenta o un auxiliar`);
      if (!account.is_active) throw invalid(`account ${account.code} is inactive`, `La cuenta ${account.code} está inactiva`);
      if (existing) await ctx.tx`update accounting.account_role_mappings set account_id = ${m.accountId} where id = ${existing.id}`;
      else await ctx.tx`insert into accounting.account_role_mappings (company_id, role, dimension, account_id) values (${ctx.companyId}, ${m.role}, ${m.dimension ?? null}, ${m.accountId})`;
      upserted++;
    }
    return { upserted, removed };
  },
});

export const accountRoleMappingConsult = defineProcess({
  id: "accounting.account_role_mapping.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.posting",
  description: "Consulta el mapeo de roles contables a cuentas y los roles que todavía no tienen cuenta",
  input: z.object({}),
  output: z.object({
    mappings: z.array(z.object({ id: z.string(), role: z.string(), dimension: z.string().nullable(), accountId: z.string(), accountCode: z.string().nullable(), accountName: z.string().nullable() })),
    unmapped: z.array(z.string()),
  }),
  handler: async (ctx) => {
    const rows = await ctx.tx<{ id: string; role: string; dimension: string | null; account_id: string; code: string | null; name: string | null }[]>`
      select m.id, m.role, m.dimension, m.account_id, a.code, a.name
      from accounting.v_account_role_mappings m left join accounting.v_accounts a on a.id = m.account_id
      order by m.role, m.dimension nulls first`;
    const base = new Set(rows.filter((r) => r.dimension === null).map((r) => r.role));
    return {
      mappings: rows.map((r) => ({ id: r.id, role: r.role, dimension: r.dimension, accountId: r.account_id, accountCode: r.code, accountName: r.name })),
      unmapped: knownRoles(ctx).filter((role) => !base.has(role)),
    };
  },
});

export const MAPPING_PROCESSES = [accountRoleMappingUpdate, accountRoleMappingConsult];
