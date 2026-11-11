import type { Sql } from "postgres";
import { z } from "zod";
import { ADMIN_FEATURE, companyRole, invalid, requireAdmin } from "../admin/common";
import { withClaims, type JwtClaims } from "../db/client";
import { defineProcess } from "../process/define";
import type { NavItem } from "../registry/types";

// Menu access (entity types spec 2026-11-02 §2.4, §9.2, D7, D12; Phase 2A.5 Task 10): the admin decides which roles and users see a
// menu item, at any level (a section, a screen). kernel.menu_access.set replaces the item's whole set of rules in one audited run (the
// process audit plus a row audit entry for every rule removed and added: the append-only history of the rules). An empty set makes the
// item follow the role permissions only again. Rules only narrow: an allowed rule never shows an item the role may not open, and no
// rule applies to a company admin. A hidden item is refused server-side as well: its screens by the proxy (kernel.menu_path_allowed)
// and its processes by kernel.can_run_process (0047). Company-admin only, step-up (rule 15).

const rule = z.object({
  roleId: z.uuid().optional(),
  userId: z.uuid().optional(),
  allowed: z.boolean(),
});
export type MenuAccessRule = z.infer<typeof rule>;

/** Every menu item of the loaded modules, groups and their children, by id. */
const menuItems = (modules: { navigation: NavItem[]; features: { nav?: NavItem[] }[] }[]): Set<string> =>
  new Set(modules.flatMap((m) => [...m.navigation, ...m.features.flatMap((f) => f.nav ?? [])]).flatMap((i) => [i.id, ...(i.children ?? []).map((c) => c.id)]));

export const menuAccessSet = defineProcess({
  id: "kernel.menu_access.set",
  module: "kernel",
  kind: "update",
  recordAccess: "none",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description:
    "Define qué roles o usuarios ven una opción del menú (una sección o una pantalla); reemplaza las reglas de la opción y, sin reglas, la opción vuelve a seguir solo los permisos del rol. Una opción oculta tampoco se abre por su dirección ni ejecuta sus procesos. Los administradores no se restringen",
  input: z.object({ navKey: z.string().min(1).max(200), rules: z.array(rule).max(200, "Máximo 200 reglas por opción del menú") }),
  output: z.object({ navKey: z.string(), rules: z.number().int() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    if (!menuItems(ctx.registry.modules()).has(input.navKey)) throw invalid(`unknown menu item ${input.navKey}`, `La opción del menú ${input.navKey} no existe`);
    // The checks read kernel.menu_items: a rule for an item it does not hold yet (not synced) would never apply, so it is refused.
    const [synced] = await ctx.tx`select 1 from kernel.menu_items where nav_key = ${input.navKey}`;
    if (!synced) throw invalid(`menu item ${input.navKey} is not in kernel.menu_items`, `La opción del menú ${input.navKey} aún no está registrada; vuelve a intentarlo en unos minutos`);

    const seen = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    for (const r of input.rules) {
      if ((r.roleId === undefined) === (r.userId === undefined)) throw invalid("a rule names exactly one grantee", "Cada regla es para un rol o para un usuario, no ambos");
      const key = r.roleId ? `role:${r.roleId}` : `user:${r.userId}`;
      if (seen.has(key)) throw invalid(`grantee ${key} is listed twice`, "Un rol o un usuario aparece en más de una regla");
      seen.add(key);
      if (r.roleId) {
        const role = await companyRole(ctx, r.roleId);
        if (role.isSystemAdmin) throw invalid(`role ${role.id} is the system admin role`, "El rol admin del sistema ve todo el menú y no se restringe");
      }
      if (r.userId) {
        // An active member only: a deactivated membership keeps its history, never a new rule.
        const [member] = await ctx.tx`select 1 from kernel.memberships where user_id = ${r.userId} and company_id = ${ctx.companyId} and is_active`;
        if (!member) throw invalid(`user ${r.userId} is not a member of the company`, "El usuario no pertenece a la empresa o está inactivo");
      }
      rows.push({ company_id: ctx.companyId, nav_key: input.navKey, grantee_role_id: r.roleId ?? null, grantee_user_id: r.userId ?? null, allowed: r.allowed });
    }
    // Replaced, never edited: the old rules are deleted and the new ones inserted; the row audit keeps both.
    await ctx.tx`delete from kernel.menu_access where company_id = ${ctx.companyId} and nav_key = ${input.navKey}`;
    if (rows.length > 0) await ctx.tx`insert into kernel.menu_access ${ctx.tx(rows)}`;
    return { navKey: input.navKey, rules: rows.length };
  },
});

export const MENU_ACCESS_PROCESSES = [menuAccessSet];

/**
 * The menu items hidden for the caller in the active company (kernel.menu_hidden_keys): empty for a company admin and for a company
 * without menu rules. A plain read as the caller, for the shell, which drops them; not a process (no audit row on every page load).
 */
export async function menuHiddenKeys(sql: Sql, claims: JwtClaims): Promise<Set<string>> {
  const [row] = await withClaims(sql, claims, (tx) => tx<{ keys: string[] }[]>`select kernel.menu_hidden_keys() as keys`);
  return new Set(row?.keys ?? []);
}

/**
 * Whether the caller may open `path` (a pathname): false for the screen of a menu item hidden for them, a page under it or a record page
 * of its entity (kernel.menu_path_allowed). The proxy's route guard; the processes behind the screen are refused by runProcess anyway.
 */
export async function menuPathAllowed(sql: Sql, claims: JwtClaims, path: string): Promise<boolean> {
  const [row] = await withClaims(sql, claims, (tx) => tx<{ allowed: boolean }[]>`select kernel.menu_path_allowed(${path}) as allowed`);
  return row?.allowed === true;
}
