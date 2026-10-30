"use server";

import { entitled, ProcessError, runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";

// The Cuentas tab accounting adds to a role or a user (`accounting.subject_accounts`, accounting design §4.15, §8): the accounts the subject
// was granted, read through `accounting.account_permission.consult` as the caller (the admin's). Without the module, the feature or the
// permission the answer is "none" and the admin screens show nothing.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAB = "accounting.subject_accounts";

export interface SubjectGrant {
  accountId: string;
  accountCode: string;
  accountName: string;
  canView: boolean;
  canPost: boolean;
  isActive: boolean;
}

export async function subjectAccountsAction(kind: "role" | "user", subjectId: string): Promise<{ ok: true; grants: SubjectGrant[] } | { ok: false }> {
  if ((kind !== "role" && kind !== "user") || !UUID.test(subjectId)) return { ok: false };
  const deps = processDeps();
  const entity = kind === "role" ? "kernel.role" : "kernel.user";
  const tab = deps.registry.recordTabsFor(entity).find((c) => c.id === TAB);
  if (!tab) return { ok: false };
  const caller = await requireCaller();
  if (!(await entitled(deps.sql, caller.claims.active_company_id, `feature:${tab.feature}`))) return { ok: false };
  try {
    const out = (await runProcess(deps, caller, "accounting.account_permission.consult", { subjectKind: kind, subjectId })) as { grants: SubjectGrant[] };
    return { ok: true, grants: out.grants };
  } catch (error) {
    if (error instanceof ProcessError && ["forbidden", "not_entitled", "not_found"].includes(error.code)) return { ok: false };
    throw error;
  }
}
