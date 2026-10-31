"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CategoryForm, EntryForm, formatMoney, gridFetcher, MasterForm, PartyForm, ProductForm, RuleForm, useTabs, type FieldMode, type SaveRecord } from "@erp/ui";
import { lookupLineAction, runEntryAction } from "@/lib/accounting/entry-actions";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { saveRecordAction } from "@/lib/records/actions";
import { NEW_RECORD_ID, recordEntity } from "@/lib/records/entities";
import type { TemplateLineView } from "@/lib/accounting/record-tabs";
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
  if (form.kind === "entry") {
    const entry = form;
    // A copy names its business unit by the label the clone read for it.
    const copied = clone?.values.business_unit_id;
    const labels = typeof copied === "string" && clone?.refLabels.business_unit_id ? { ...entry.labels, [copied]: clone.refLabels.business_unit_id } : entry.labels;
    return (
      <EntryForm
        key={key}
        settings={entry.settings}
        journals={entry.journals}
        defaultJournalId={entry.defaultJournalId}
        userId={entry.userId}
        can={entry.can}
        labels={labels}
        record={record}
        initial={record ? null : (clone?.values ?? null)}
        canSave={!readOnly}
        lookup={lookupLineAction}
        runAction={runEntryAction}
        requestStepUp={requestStepUp}
        save={save}
        onSaved={onSaved}
        onActed={() => router.refresh()}
      />
    );
  }
  if (form.kind === "master") {
    const processes = recordEntity(entity);
    const masterProps = {
      ...common,
      options: form.options,
      ...(form.templateLines ? { footer: <TemplateLines lines={form.templateLines} /> } : {}),
    };
    if (form.master === "rule") return <RuleForm key={key} {...masterProps} isDefault={form.rule?.isDefault ?? false} isModified={form.rule?.isModified ?? false} />;
    return <MasterForm key={key} kind={form.master} processes={{ create: processes?.create ?? "", update: processes?.update ?? "" }} {...masterProps} />;
  }
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

/** The lines of a plantilla de comprobante, read-only under its header (they are written in the plantilla's own process). */
function TemplateLines({ lines }: { lines: TemplateLineView[] }) {
  const t = useTranslations("accounting.record.form");
  return (
    <section className="erp-sec">
      <h3>{t("template_lines")}</h3>
      <div className="erp-lines__scroll">
        <table className="erp-lines__table" aria-label={t("template_lines")}>
          <thead>
            <tr>
              <th scope="col" className="erp-lines__no">
                #
              </th>
              <th scope="col">{t("template_account")}</th>
              <th scope="col">{t("template_side")}</th>
              <th scope="col" className="erp-num">
                {t("template_amount")}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.lineNo}>
                <td className="erp-lines__no erp-muted">{l.lineNo}</td>
                <td>{l.account}</td>
                <td>{t(`side.${l.side}`)}</td>
                <td className="erp-num erp-mono">{l.amount === null ? t("asked") : formatMoney(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
