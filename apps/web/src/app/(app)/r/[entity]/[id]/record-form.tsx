"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ActivityForm,
  CategoryForm,
  EntryForm,
  formatMoney,
  FulfilForm,
  gridFetcher,
  LeadForm,
  MasterForm,
  OpportunityForm,
  PartyForm,
  PaymentMasterForm,
  PipelineForm,
  ReceiptForm,
  ProductForm,
  RuleForm,
  SaleDocumentForm,
  StockDocumentForm,
  StockMasterForm,
  useTabs,
  type FieldMode,
  type SaveRecord,
} from "@erp/ui";
import { saveStockDocumentAction } from "@/lib/inventory/actions";
import { lookupLineAction } from "@/lib/accounting/entry-actions";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { saveRecordAction } from "@/lib/records/actions";
import { openCreatedRecord } from "@/lib/records/open-created";
import { NEW_RECORD_ID, recordEntity } from "@/lib/records/entities";
import type { TemplateLineView } from "@/lib/accounting/record-tabs";
import type { FormData } from "@/lib/records/load";
import { useRecordClone, useSaveHold } from "./record-frame";
import { SalesRecordView } from "./sales-view";
import { InvoicingRecordView } from "./invoicing-view";
import { AdvanceApplicationNew, ApplicationRecordView } from "./advance-view";
import { ReceiptRecordView } from "./payments-view";
import { openInvoicesAction } from "@/lib/payments/actions";
import { StockRecordView } from "./stock-view";

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
  const open = useTabs((s) => s.open);
  const newTabTitle = useTabs((s) => s.tabs.find((tab) => tab.href === `/r/${entity}/${NEW_RECORD_ID}`)?.title ?? "");
  const { clone, done } = useRecordClone();
  const saveHold = useSaveHold();
  const save: SaveRecord = useCallback(
    async (input, token) => {
      const result = await (clone && !record ? saveRecordAction(entity, { ...clone.carry, ...input }, token, { sourceRowId: clone.sourceRowId }) : saveRecordAction(entity, input, token));
      // The version the save wrote goes to the bar's lifecycle step (minor 9: «Guardar y enviar a aprobación» submits with it).
      if (result.ok) saveHold?.saved(result.id, result.updatedAt ?? null, result.status ?? null);
      return result;
    },
    [entity, clone, record, saveHold],
  );
  const saveStock: SaveRecord = useCallback(
    async (input, token) => {
      const result = await saveStockDocumentAction(entity, input, token);
      if (result.ok) saveHold?.saved(result.id, null);
      return result;
    },
    [entity, saveHold],
  );
  const onSaved = (id: string, created: boolean) => {
    // The action bar's Guardar goes on (lifecycle step) and then opens or reloads the record itself.
    saveHold?.saved(id);
    if (saveHold?.held()) return;
    // Saved with the step-up code its save asked for: the bar's step goes on, then it opens or reloads the record (minor 6).
    if (saveHold?.resume(id)) return;
    if (created) {
      done();
      openCreatedRecord({ open, close, replace: (href) => router.replace(href) }, entity, id, newTabTitle);
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
        labels={labels}
        linesGrid={entry.linesGrid}
        record={record}
        initial={record ? null : (clone?.values ?? entry.prefill)}
        fromTemplate={entry.fromTemplate}
        canSave={!readOnly}
        lookup={lookupLineAction}
        requestStepUp={requestStepUp}
        save={save}
        onSaved={onSaved}
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
    if (form.master === "rule") return <RuleForm key={key} {...masterProps} isDefault={form.rule?.isDefault ?? false} isModified={form.rule?.isModified ?? false} stale={form.rule?.stale ?? false} staleDays={form.rule?.staleDays ?? 30} />;
    return <MasterForm key={key} kind={form.master} processes={{ create: processes?.create ?? "", update: processes?.update ?? "" }} {...masterProps} />;
  }
  if (form.kind === "stock") {
    // Inventory and costing (plan 2B Task 10): the bodega and the ubicación edit in place; a new document saves through the process its
    // form names (an ajuste asks for the step-up code); a stored one shows its facts, its lines and its own steps.
    if (form.stock === "warehouse" || form.stock === "location") {
      const processes = recordEntity(entity);
      return <StockMasterForm key={key} kind={form.stock} {...common} warehouses={form.warehouses} processes={{ create: processes?.create ?? "", update: processes?.update ?? "" }} />;
    }
    if (record && form.view) return <StockRecordView entity={entity} recordId={record.id} view={form.view} />;
    return (
      <StockDocumentForm
        key={key}
        kind={form.stock}
        today={form.today}
        warehouses={form.warehouses}
        locations={form.locations}
        product={form.product}
        {...(form.receipt ? { receipt: form.receipt } : {})}
        {...(form.party ? { party: form.party } : {})}
        costCenter={form.costCenter}
        initial={clone?.values ?? null}
        readOnly={readOnly}
        save={saveStock}
        requestStepUp={requestStepUp}
        onSaved={onSaved}
      />
    );
  }
  if (form.kind === "sales") {
    // CRM and Ventas (plan 2B Task 14b): a new record saves through its entity's create process (the bar's Guardar); a stored cotización
    // or pedido shows its facts, totals, lines and steps, and edits in place while it is still open; a prospecto and an embudo edit in
    // place (the prospecto with its Convertir panel); an entrega, devolución, oportunidad or actividad never changes but through its steps.
    const processes = recordEntity(entity);
    const pair = { create: processes?.create ?? "", update: processes?.update ?? "" };
    const shared = { readOnly, save, requestStepUp, onSaved, processes: pair };
    const copy = clone?.values ?? null;
    const copyLabels = clone?.refLabels ?? {};
    if (form.sales === "quote" || form.sales === "order") {
      const docForm = (stored: boolean) => (
        <SaleDocumentForm
          key={stored ? `${key}-edit` : key}
          kind={form.sales as "quote" | "order"}
          record={stored ? record : null}
          lines={stored ? form.lines : []}
          labels={stored ? form.labels : copyLabels}
          initial={stored ? null : copy}
          copyOf={stored ? null : (clone?.sourceRowId ?? null)}
          today={form.today}
          warehouses={form.warehouses}
          currencies={form.currencies}
          companyCurrency={form.companyCurrency}
          party={form.party}
          product={form.product}
          opportunity={form.opportunity}
          modes={modes}
          lineModes={form.lineModes}
          {...shared}
        />
      );
      if (record && form.view) return <SalesRecordView entity={entity} recordId={record.id} view={form.view} warehouses={form.warehouses} {...(form.editable && !readOnly ? { editForm: docForm(true) } : {})} />;
      return docForm(false);
    }
    if (form.sales === "lead") {
      const leadForm = <LeadForm key={key} record={record} initial={record ? null : copy} documentTypes={form.documentTypes} {...shared} />;
      if (record && form.view) return <SalesRecordView entity={entity} recordId={record.id} view={form.view} lead={{ form: leadForm, record, documentTypes: form.documentTypes }} />;
      return leadForm;
    }
    if (form.sales === "pipeline") return <PipelineForm key={key} record={record} stages={form.lines} initial={record ? null : copy} copyOf={record ? null : (clone?.sourceRowId ?? null)} {...shared} />;
    if (record && form.view) return <SalesRecordView entity={entity} recordId={record.id} view={form.view} />;
    if (form.sales === "delivery" || form.sales === "return") {
      return <FulfilForm key={key} kind={form.sales} today={form.today} warehouses={form.warehouses} source={form.source ?? { fields: [], entityLabel: "" }} initial={copy} {...shared} />;
    }
    if (form.sales === "opportunity") return <OpportunityForm key={key} pipelines={form.pipelines} party={form.party} lead={form.lead} product={form.product} initial={copy} labels={copyLabels} {...shared} />;
    return <ActivityForm key={key} party={form.party} lead={form.lead} opportunity={form.opportunity} initial={copy} labels={copyLabels} {...shared} />;
  }
  if (form.kind === "invoicing") {
    // Facturación (plan 2B Task 20): a new invoice (Nueva factura, Duplicar) is written by hand and saved as a Borrador (the bar's Guardar
    // only saves: «Emitir» is the invoice's own step); a stored one shows its facts, DIAN trail, totals and steps, and a Borrador edits in
    // place (the lines only when it was written by hand: one of pedidos bills what shipped). A note is written from its invoice.
    const processes = recordEntity(entity);
    const shared = { readOnly, save, requestStepUp, onSaved, processes: { create: processes?.create ?? "", update: processes?.update ?? "" } };
    const invoiceForm = (stored: boolean) => (
      <SaleDocumentForm
        key={stored ? `${key}-edit` : key}
        kind="invoice"
        record={stored ? record : null}
        lines={stored ? form.lines : []}
        labels={stored ? form.labels : (clone?.refLabels ?? {})}
        initial={stored ? null : (clone?.values ?? null)}
        copyOf={stored ? null : (clone?.sourceRowId ?? null)}
        today={form.today}
        party={form.party}
        product={form.product}
        paymentMeans={form.paymentMeans}
        currencies={form.currencies}
        companyCurrency={form.companyCurrency}
        linesFixed={stored && form.linesFixed}
        modes={modes}
        lineModes={form.lineModes}
        {...shared}
      />
    );
    if (record && form.view) {
      return <InvoicingRecordView entity={entity} recordId={record.id} view={form.view} {...(form.editable && !readOnly ? { editForm: invoiceForm(true) } : {})} />;
    }
    return invoiceForm(false);
  }
  if (form.kind === "payments") {
    // Pagos (plan 2B Task 24b): a medio de pago and a caja edit in place; «Registrar pago» (Nuevo recibo, Duplicar) is the receipt's create
    // process and posts at once, so a stored receipt never edits: it shows its facts, totals and what it applied, and «Anular recibo».
    if (form.payments === "method" || form.payments === "cash_box") {
      const processes = recordEntity(entity);
      return <PaymentMasterForm key={key} kind={form.payments} {...common} meansCodes={form.meansCodes} processes={{ create: processes?.create ?? "", update: processes?.update ?? "" }} />;
    }
    // An application of an advance is written from the receipt that holds it (Aplicar a facturas): its page shows the stored one, read only.
    if (form.payments === "advance_application") return record && form.application ? <ApplicationRecordView view={form.application} /> : <AdvanceApplicationNew />;
    if (record && form.view) return <ReceiptRecordView view={form.view} recordId={record.id} />;
    return (
      <ReceiptForm
        key={key}
        today={form.today}
        companyCurrency={form.companyCurrency}
        methods={form.methods}
        cashBoxes={form.cashBoxes}
        party={form.party}
        invoicesLinkable={form.invoicesLinkable}
        initial={clone?.values ?? null}
        labels={clone?.refLabels ?? {}}
        readOnly={readOnly}
        loadInvoices={openInvoicesAction}
        process={recordEntity(entity)?.create ?? ""}
        save={save}
        requestStepUp={requestStepUp}
        onSaved={onSaved}
      />
    );
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
