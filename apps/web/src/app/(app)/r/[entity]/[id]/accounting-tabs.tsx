"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { AccountSecurityTab, RuleLinesEditor, RuleTestTab, type AccountSecurityTabProps, type RuleLine, type RuleLinesEditorProps, type RuleTestTabProps, type SaveRecord } from "@erp/ui";
import { saveSecurityAction, testRuleAction } from "@/lib/accounting/record-actions";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { saveRecordAction } from "@/lib/records/actions";

// The tabs of the accounting records that write or run a process, wired to the app: each saves through a server action (rule 1), asks
// for the step-up code in place when the process requires it and reloads the record once it is saved.

export function SecurityPanel(props: Omit<AccountSecurityTabProps, "save" | "requestStepUp" | "onSaved">) {
  const router = useRouter();
  return <AccountSecurityTab {...props} save={saveSecurityAction} requestStepUp={requestStepUp} onSaved={() => router.refresh()} />;
}

export function RuleLinesPanel({ ruleId, ...props }: Omit<RuleLinesEditorProps, "save" | "requestStepUp" | "onSaved">) {
  const router = useRouter();
  const save: SaveRecord = useCallback((input, token) => saveRecordAction("accounting.posting_rule", input, token), []);
  return <RuleLinesEditor {...props} ruleId={ruleId} save={save} requestStepUp={requestStepUp} onSaved={() => router.refresh()} />;
}

export function RuleTestPanel({ ruleId, ...props }: Omit<RuleTestTabProps, "test"> & { ruleId: string }) {
  const test = useCallback((outboxId: string) => testRuleAction(ruleId, outboxId), [ruleId]);
  return <RuleTestTab {...props} test={test} />;
}

export type { RuleLine };
