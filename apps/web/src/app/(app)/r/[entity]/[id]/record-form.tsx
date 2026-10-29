"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { CategoryForm, gridFetcher, PartyForm, ProductForm, useTabs, type FieldMode, type SaveRecord } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { saveRecordAction } from "@/lib/records/actions";
import { NEW_RECORD_ID } from "@/lib/records/entities";
import type { FormData } from "@/lib/records/load";
import { useRecordClone } from "./record-frame";

export interface RecordFormProps {
  entity: string;
  record: (Record<string, unknown> & { id: string }) | null;
  modes: Record<string, FieldMode>;
  readOnly: boolean;
  form: FormData;
}

/**
 * The Datos tab of a record wired to the app: saves through the entity's processes (server action), asks for the
 * step-up code when a process requires it, and after saving either reloads the record or, for a new one, replaces the
 * "new" tab with the created record's. A new record opened by "Duplicar" starts from the copy, sends the copy's extra
 * data with the form's input and names the source, so the creation's audit records it (rule 37).
 */
export function RecordForm({ entity, record, modes, readOnly, form }: RecordFormProps) {
  const router = useRouter();
  const close = useTabs((s) => s.close);
  const { clone, done } = useRecordClone();
  const save: SaveRecord = useCallback(
    (input, token) => (clone && !record ? saveRecordAction(entity, { ...clone.carry, ...input }, token, { sourceRowId: clone.sourceRowId }) : saveRecordAction(entity, input, token)),
    [entity, clone, record],
  );
  const onSaved = (id: string, created: boolean) => {
    if (created) {
      done();
      close(`/r/${entity}/${NEW_RECORD_ID}`);
      router.replace(`/r/${entity}/${id}`);
    } else router.refresh();
  };
  const common = { record, initial: record ? null : (clone?.values ?? null), readOnly, save, requestStepUp, onSaved };
  // A new copy (or none after a save) starts the form over: the page may have been kept alive with an earlier one.
  const key = record ? record.id : clone ? `copy-${clone.handoffId}` : "new";
  if (form.kind === "party") return <PartyForm key={key} {...common} tables={form.tables} modes={modes} />;
  if (form.kind === "category") return <CategoryForm key={key} {...common} tables={form.tables} productCount={form.productCount} />;
  return (
    <ProductForm
      key={key}
      {...common}
      tables={form.tables}
      categories={form.categories}
      modes={modes}
      supplier={{ ...form.supplier, label: clone?.refLabels.supplier_id ?? form.supplier.label, fetcher: gridFetcher("core.party"), baseFilters: [{ field: "kind", op: "eq", value: "supplier" }] }}
    />
  );
}
