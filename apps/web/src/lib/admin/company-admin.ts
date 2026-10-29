import type { Tx } from "@erp/kernel";

// Who administers the active company (design §6): a holder of the system admin role there, `kernel.is_company_admin()`
// under the caller's claims. The administration screens (users' pages included) and the links that lead to them ask
// the same question.

/** Whether the caller whose claims `tx` carries is the company admin. */
export async function callerIsCompanyAdmin(tx: Tx): Promise<boolean> {
  const [row] = await tx<{ admin: boolean }[]>`select kernel.is_company_admin() as admin`;
  return row?.admin === true;
}
