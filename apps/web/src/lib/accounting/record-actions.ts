"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import type { RuleTestResult, SaveResult } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { issuesOf } from "@/lib/records/issues";
import { processDeps } from "@/lib/server/runtime";

// What the tabs of the accounting records ask of the server (accounting design §8, Task 28). Every write is a registered process run
// as the session's user (rule 1); a step-up token answers a `step_up_required`.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Seguridad of a Cuenta: `accounting.account_permission.update` (admin, step-up). */
export async function saveSecurityAction(input: Record<string, unknown>, stepUpToken?: string): Promise<SaveResult> {
  if (typeof input !== "object" || input === null || typeof input.accountId !== "string" || !UUID.test(input.accountId)) return { ok: false, code: "invalid_input", details: [] };
  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  try {
    await runProcess(processDeps(), caller, "accounting.account_permission.update", input);
    return { ok: true, id: input.accountId };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: issuesOf(error.details) };
    throw error;
  }
}

interface Previewed {
  ok: boolean;
  code?: string;
  detail?: string;
  reverseOf?: string;
  entry?: { description?: string; lines: { accountCode?: string; role?: string; side: "debit" | "credit"; amountCompany: number; description?: string }[] };
}

/** Probar con un evento real: `accounting.posting_rule.test` for the rule and a past event of the company. */
export async function testRuleAction(ruleId: string, outboxId: string): Promise<RuleTestResult | { error: string }> {
  if (typeof ruleId !== "string" || typeof outboxId !== "string" || !UUID.test(ruleId) || !UUID.test(outboxId)) return { error: "invalid_input" };
  const caller = await requireCaller();
  try {
    const result = (await runProcess(processDeps(), caller, "accounting.posting_rule.test", { ruleId, outboxId })) as Previewed;
    if (!result.ok) return { ok: false, code: result.code ?? "invalid_template", detail: result.detail ?? "" };
    if (result.reverseOf) return { ok: true, lines: [], description: null, reverseOf: result.reverseOf };
    return {
      ok: true,
      reverseOf: null,
      description: result.entry?.description ?? null,
      lines: (result.entry?.lines ?? []).map((l) => ({ accountCode: l.accountCode ?? null, role: l.role ?? null, side: l.side, amountCompany: l.amountCompany, description: l.description ?? null })),
    };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { error: error.code };
    throw error;
  }
}
