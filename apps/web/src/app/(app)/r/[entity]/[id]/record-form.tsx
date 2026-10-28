"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { CategoryForm, gridFetcher, PartyForm, ProductForm, useTabs, type FieldMode, type RequestStepUp, type SaveRecord } from "@erp/ui";
import { saveRecordAction } from "@/lib/records/actions";
import { NEW_RECORD_ID } from "@/lib/records/entities";
import type { FormData } from "@/lib/records/load";

export interface RecordFormProps {
  entity: string;
  record: (Record<string, unknown> & { id: string }) | null;
  modes: Record<string, FieldMode>;
  readOnly: boolean;
  form: FormData;
}

/** A TOTP code for the step-up endpoint (rule 15). */
const requestStepUp: RequestStepUp = async (code) => {
  const response = await fetch("/api/auth/step-up", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const body = (await response.json().catch(() => null)) as { token?: string; code?: string } | null;
  return response.ok && body?.token ? { token: body.token } : { error: body?.code ?? "unavailable" };
};

/**
 * The Datos tab of a record wired to the app: saves through the entity's processes (server action), asks for the
 * step-up code when a process requires it, and after saving either reloads the record or, for a new one, replaces the
 * "new" tab with the created record's.
 */
export function RecordForm({ entity, record, modes, readOnly, form }: RecordFormProps) {
  const router = useRouter();
  const close = useTabs((s) => s.close);
  const save: SaveRecord = useCallback((input, token) => saveRecordAction(entity, input, token), [entity]);
  const onSaved = (id: string, created: boolean) => {
    if (created) {
      close(`/r/${entity}/${NEW_RECORD_ID}`);
      router.replace(`/r/${entity}/${id}`);
    } else router.refresh();
  };
  const common = { record, readOnly, save, requestStepUp, onSaved };
  if (form.kind === "party") return <PartyForm {...common} tables={form.tables} modes={modes} />;
  if (form.kind === "category") return <CategoryForm {...common} tables={form.tables} productCount={form.productCount} />;
  return (
    <ProductForm
      {...common}
      tables={form.tables}
      categories={form.categories}
      modes={modes}
      supplier={{ ...form.supplier, fetcher: gridFetcher("core.party"), baseFilters: [{ field: "kind", op: "eq", value: "supplier" }] }}
    />
  );
}
