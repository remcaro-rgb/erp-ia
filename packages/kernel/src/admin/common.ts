import type { ProcessContext } from "../process/context";
import { ProcessError } from "../process/errors";

// Shared by the admin processes (design §6): the feature they belong to, the admin check every handler makes (the role
// matrix lets the process run; the company admin role is what may administer), and the refusals they answer with.

/** Every admin process belongs to this feature; `kernel.sync_sensitive_defaults` marks its processes sensitive. */
export const ADMIN_FEATURE = "kernel.admin";

/** A typed refusal of the input: `details` are the messages the admin screen shows (es-419). */
export const invalid = (message: string, detail: string): ProcessError => new ProcessError("invalid_input", message, { details: [detail] });

/** Refuses a caller who holds no system admin role in the active company (`kernel.is_company_admin()`). */
export async function requireAdmin(ctx: ProcessContext): Promise<void> {
  const [row] = await ctx.tx<{ admin: boolean }[]>`select kernel.is_company_admin() as admin`;
  if (!row?.admin) throw new ProcessError("forbidden", "only the company admin may administer the company");
}

export interface CompanyRole {
  id: string;
  name: string;
  isSystemAdmin: boolean;
}

/** A role of the active company, or `invalid_input`. */
export async function companyRole(ctx: ProcessContext, roleId: string): Promise<CompanyRole> {
  const [row] = await ctx.tx<{ id: string; name: string; system_admin: boolean }[]>`
    select id, name, is_system and name = 'admin' as system_admin from kernel.roles where id = ${roleId} and company_id = ${ctx.companyId}`;
  if (!row) throw invalid(`role ${roleId} is not a role of the company`, "El rol no pertenece a la empresa");
  return { id: row.id, name: row.name, isSystemAdmin: row.system_admin };
}

/** The system admin role is not edited from the matrices: it holds every process and sees every field. */
export function refuseSystemAdmin(role: CompanyRole): void {
  if (role.isSystemAdmin) throw invalid(`role ${role.id} is the system admin role`, "El rol admin del sistema tiene todos los permisos y no se modifica");
}
