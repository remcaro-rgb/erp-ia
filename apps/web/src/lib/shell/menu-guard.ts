import "server-only";
import { getServiceDb, menuPathAllowed, type JwtClaims } from "@erp/kernel";

// The route guard of menu access (entity types spec 2026-11-02 §9.2, Task 10): a screen whose menu item the company's rules hide for the
// caller is refused server-side, however its address was reached (a link, a saved tab, typed in). The proxy asks before every page
// request; one stable SQL call that answers at once for a company without menu rules and for an admin. The item's processes are refused
// by runProcess as well (kernel.can_run_process), so this guard is never the only one.

/** Whether `pathname` is the screen of a menu item hidden for the caller, a page under it or a record page of its entity. */
export async function menuHides(claims: JwtClaims, pathname: string): Promise<boolean> {
  return !(await menuPathAllowed(getServiceDb(), claims, pathname));
}
