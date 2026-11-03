"use client";

import { useRouter } from "next/navigation";
import { AccessTab, type AccessGrant, type AccessOption } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { setRecordAccessAction } from "@/lib/records/lifecycle-actions";

/** The Acceso tab of a maestro or documento wired to `kernel.record_access.set` (admins only; the page shows it only to them). */
export function AccessPanel({ entity, recordId, entityType, grants, options }: { entity: string; recordId: string; entityType: "maestro" | "documento"; grants: AccessGrant[]; options: AccessOption[] }) {
  const router = useRouter();
  return (
    <AccessTab
      entityType={entityType}
      grants={grants}
      options={options}
      requestStepUp={requestStepUp}
      onSave={async (next, token) => {
        const outcome = await setRecordAccessAction(entity, recordId, next, token);
        if (outcome.ok) router.refresh();
        return outcome;
      }}
    />
  );
}
