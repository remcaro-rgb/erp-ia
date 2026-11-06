"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRecordBridge } from "../record/record-bridge";
import { Field, MaskedField, RecordForm, SAVE_SHORTCUTS, Section, SelectField, TextField, failureMessages, useErrorText } from "../forms/form-parts";
import { ProcessId } from "../forms/ProcessId";
import type { CodeOption, RequestStepUp, SaveRecord } from "../forms/save-model";
import { StepUpPrompt } from "../forms/StepUpPrompt";
import { useSaveFlow, type SaveFlow } from "../forms/use-save";
import { gridFetcher } from "../grid/fetch-grid";
import type { FieldMode, GridRow } from "../grid/types";
import { EntityLookup } from "../lookup/EntityLookup";
import { recordHref } from "../record/record-model";
import type { LookupSource } from "../inventory/StockForms";
import {
  activityDraft,
  activityInput,
  activityMissing,
  ACTIVITY_KIND_OPTIONS,
  emptyOpportunityLine,
  emptySaleLine,
  emptyStage,
  fulfilDraft,
  fulfilInput,
  fulfilMissing,
  leadDraft,
  leadInput,
  leadMissing,
  LEAD_SOURCE_OPTIONS,
  MANUAL_LEAD_STAGES,
  opportunityDraft,
  opportunityInput,
  opportunityMissing,
  pipelineDraft,
  pipelineInput,
  pipelineMissing,
  saleDraft,
  saleInput,
  saleMissing,
  STAGE_KIND_OPTIONS,
  type ActivityDraft,
  type FulfilDraft,
  type LeadDraft,
  type OpportunityDraft,
  type OpportunityLine,
  type PipelineDraft,
  type SaleDocumentKind,
  type SaleDraft,
  type SaleLine,
  type StageDraft,
} from "./sales-form-model";

// The Datos tab of the CRM and sales records (plan 2B Task 14b, prototype 2B): the cotización and the pedido (a customer and priced
// lines: the price list, the discount and the taxes are the processes'), the entrega and the devolución (the lines of a pedido or a
// entrega and how much of each goes), the prospecto, the embudo with its etapas, the oportunidad and the actividad. Each saves through
// its entity's create or update process (the record frame's Guardar runs the save); a refusal shows the process's own reasons, a
// customer or product not ready to invoice shows disabled in its box with why (design §5.17).

type Row = Record<string, unknown> & { id: string };

interface CommonProps {
  readOnly?: boolean;
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  onSaved?: (id: string, created: boolean) => void;
  processes: { create: string; update: string };
}

const productRow = (row: GridRow) => `${String(row.sku ?? "")} · ${String(row.description ?? "")}`;
const partyRow = (row: GridRow) => ({ label: String(row.legal_name ?? row.id), sub: [row.document_number, row.municipality_code].filter(Boolean).join(" · ") });

/** The panel of a refusal and the bottom row (status, process id, own save button outside the bar). */
function FormFooter({ flow, missing, missingText, process, isNew, dirty, readOnly, onSave, onDiscard, panel }: {
  flow: SaveFlow;
  missing: string[];
  missingText: (key: string) => string;
  process: string;
  isNew: boolean;
  dirty: boolean;
  readOnly: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  panel: string[];
}) {
  const tf = useTranslations("common.forms");
  const tc = useTranslations("common");
  const ts = useTranslations("sales.form");
  const bridge = useRecordBridge();
  return (
    <>
      {panel.length > 0 && (
        <div className="erp-dian erp-dian--bad" role="alert" tabIndex={-1} data-error-summary="">
          <b>{panel.join(" · ")}</b>
        </div>
      )}
      {!readOnly && (
        <div className="erp-form__actions">
          {flow.stepUp && <StepUpPrompt onConfirm={(code) => void flow.confirmStepUp(code)} onCancel={flow.cancelStepUp} error={flow.stepUpError} busy={flow.saving} />}
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {flow.saving ? tf("saving") : missing.length > 0 ? `${ts("missing")}: ${missing.map(missingText).join(", ")}` : ""} <kbd className="erp-mono">{tf("save_hint")}</kbd> · <ProcessId id={process} />
            </span>
            {/* In a record frame its header carries «Descartar cambios» (owner 2026-11-05). */}
            {dirty && !isNew && onDiscard && !bridge?.registered && (
              <button type="button" className="erp-btn" onClick={onDiscard} disabled={flow.saving}>
                {tf("discard")}
              </button>
            )}
            {!bridge?.registered && (
              <button type="button" className="erp-btn erp-btn--primary" aria-keyshortcuts={SAVE_SHORTCUTS} onClick={onSave} disabled={missing.length > 0 || flow.saving || flow.stepUp || (!dirty && !isNew)}>
                {isNew ? tf("create") : tc("save")}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** A date box (ISO yyyy-mm-dd, the browser's own picker). */
function DateField({ label, value, disabled, error, onChange }: { label: string; value: string; disabled?: boolean; error?: string | null; onChange: (value: string) => void }) {
  return (
    <Field label={label} error={error}>
      {(id, describedBy) => <input id={id} type="date" value={value} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

function AreaField({ label, value, disabled, onChange, maxLength = 2000 }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void; maxLength?: number }) {
  return (
    <Field label={label} className="erp-span3">
      {(id) => <textarea id={id} rows={2} value={value} maxLength={maxLength} disabled={disabled} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

function Flag({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  const tc = useTranslations("common");
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} className={on ? "erp-flag is-on" : "erp-flag"} onClick={() => !disabled && onChange(!on)}>
      <i aria-hidden="true" className="erp-flag__dot" />
      {label} <span className="erp-flag__state">{on ? tc("yes") : tc("no")}</span>
    </button>
  );
}

/** Keeps a draft in step with the stored record: a reload after a save starts from what was saved. */
function useDraft<T>(key: string, make: () => T): [T, T, (next: T | ((d: T) => T)) => void, () => void] {
  const [seen, setSeen] = useState(key);
  const [initial, setInitial] = useState(make);
  const [draft, setDraft] = useState(initial);
  if (seen !== key) {
    const next = make();
    setSeen(key);
    setInitial(next);
    setDraft(next);
  }
  return [draft, initial, setDraft, () => setDraft(initial)];
}

/**
 * Duplicar (rule 37): the lines of the record copied, read through its lines grid as the caller (masks apply: a masked price comes empty
 * and the process prices the line again). The header comes with the copy; the lines are not part of it.
 */
function useCopiedLines(linesEntity: string, parentField: string, sourceId: string | null | undefined, onRows: (rows: GridRow[]) => void) {
  const [done, setDone] = useState(false);
  // The form's setter, read when the rows arrive: a new function each render does not fetch again.
  const latest = useRef(onRows);
  useEffect(() => {
    latest.current = onRows;
  });
  useEffect(() => {
    if (!sourceId || done) return;
    const controller = new AbortController();
    gridFetcher(linesEntity)({ filters: [{ field: parentField, op: "eq", value: sourceId }], sort: [{ field: "line_no", dir: "asc" }], page: 1, pageSize: 500 }, controller.signal)
      .then((page) => {
        setDone(true);
        latest.current(page.rows);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [linesEntity, parentField, sourceId, done]);
}

/** Where Duplicar reads a document's lines from (its lines entity and the parent column). */
const COPIED_LINES: Readonly<Record<SaleDocumentKind, { entity: string; parent: string }>> = {
  quote: { entity: "crm.quote_line", parent: "quote_id" },
  order: { entity: "sales.order_line", parent: "order_id" },
  invoice: { entity: "invoicing.invoice_line", parent: "invoice_id" },
};

/** A copied number as the box shows it; a masked or missing one stays empty. */
const copiedNumber = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) ? String(Number(v)) : "");

// ---------------------------------------------------------------------------------------------------------------------------------

export interface SaleDocumentFormProps extends CommonProps {
  /** A cotización, a pedido or (plan 2B Task 20) a factura written by hand or still a Borrador. */
  kind: SaleDocumentKind;
  /** The stored, open cotización or pedido (edited through its update process); null for a new one. */
  record: Row | null;
  /** Its lines (as the lines grid reads them, with `product_label`). */
  lines?: readonly Record<string, unknown>[];
  /** How the stored references read (`party_id`, `opportunity_id`). */
  labels?: Readonly<Record<string, string>>;
  /** A copy ("Duplicar") of a stored one: its header. */
  initial?: Readonly<Record<string, unknown>> | null;
  /** The record a copy comes from: its lines are copied too. */
  copyOf?: string | null;
  today: string;
  /** A pedido's bodegas (inventory's, masked view). */
  warehouses?: readonly CodeOption[];
  party: LookupSource;
  product: LookupSource;
  opportunity?: LookupSource | null;
  /** How the caller sees the header's fields (rule 14): a masked or hidden one shows masked, is not edited and is never sent. */
  modes?: Readonly<Record<string, FieldMode>>;
  /** How the caller sees the lines' fields: with the price or the discount masked the lines are not edited (sending them re-prices). */
  lineModes?: Readonly<Record<string, FieldMode>>;
  /** An invoice: the DIAN payment means the country pack accepts (code and name). */
  paymentMeans?: readonly CodeOption[];
  /** An invoice of pedidos: its lines bill what shipped and are not edited here (the header is). */
  linesFixed?: boolean;
}

export function SaleDocumentForm({ kind, record, lines = [], labels = {}, initial: copy, copyOf = null, today, warehouses = [], party, product, opportunity, readOnly = false, save, requestStepUp, onSaved, processes, modes = {}, lineModes = {}, paymentMeans = [], linesFixed = false }: SaleDocumentFormProps) {
  const t = useTranslations("sales.form");
  const ti = useTranslations("invoicing.form");
  const errorText = useErrorText();
  const isNew = record === null;
  const key = record ? `${record.id}:${String(record.updated_at ?? "")}` : "new";
  const [draft, initial, setDraft, discard] = useDraft<SaleDraft>(key, () => (record ? saleDraft(today, record, lines, labels) : saleDraft(today, copy ?? null, [], labels)));
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, isNew));
  const failed = failureMessages(flow.failure, ["partyId", "opportunityId", "issueDate", "validUntil", "deliveryDate", "warehouseId", "dueDate", "paymentForm", "paymentMeans", "notes"], errorText);
  const missing = saleMissing(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  // A stored record's masked fields never reached the form (rule 14): they are not edited and never sent. A new one has none to keep.
  const masked = new Set(isNew ? [] : Object.entries(modes).filter(([, m]) => m !== "visible").map(([f]) => f));
  const isMasked = (field: string) => masked.has(field);
  const linesLocked = readOnly || linesFixed || (!isNew && ["unit_price", "discount_pct", "qty"].some((f) => (lineModes[f] ?? "visible") !== "visible"));
  const send = () => flow.submit(saleInput(kind, draft, record ? record.id : null, { initial, masked, linesLocked: linesFixed }));
  const submit = () => void send();
  const set = <K extends keyof SaleDraft>(k: K) => (value: SaleDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const setLine = (lineKey: string, patch: Partial<SaleLine>) =>
    setDraft((d) => {
      const next = d.lines.map((l) => (l.key === lineKey ? { ...l, ...patch } : l));
      // A product chosen on the last line opens the next one.
      const last = next.at(-1);
      return { ...d, lines: last && last.productId !== "" ? [...next, emptySaleLine()] : next };
    });
  const removeLine = (lineKey: string) => setDraft((d) => ({ ...d, lines: d.lines.length > 1 ? d.lines.filter((l) => l.key !== lineKey) : [emptySaleLine()] }));
  const productFetcher = gridFetcher("core.product");
  const copied = COPIED_LINES[kind];
  useCopiedLines(copied.entity, copied.parent, isNew ? copyOf : null, (rows) =>
    setDraft((d) =>
      d.lines.some((l) => l.productId !== "")
        ? d
        : {
            ...d,
            lines: [
              ...rows.map((r) => ({
                ...emptySaleLine(),
                productId: String(r.product_id ?? ""),
                productLabel: String(r.product_id_label ?? r.product_id ?? ""),
                qty: copiedNumber(r.qty),
                unitPrice: copiedNumber(r.unit_price),
                discountPct: Number(r.discount_pct ?? 0) === 0 ? "" : copiedNumber(r.discount_pct),
                description: typeof r.description === "string" ? r.description : "",
              })).filter((l) => l.productId !== ""),
              emptySaleLine(),
            ],
          },
    ),
  );

  return (
    <RecordForm canSave={!readOnly && missing.length === 0 && !flow.saving && !flow.stepUp && (dirty || isNew)} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure} {...(isNew ? {} : { onDiscard: discard })}>
      <Section title={kind === "invoice" ? ti("section") : t(`section.${kind}`)}>
        <div className="erp-form2">
          <Field label={`${t("customer")} *`} hint={isNew ? t("customer_hint") : undefined} error={failed.field("partyId")} className="erp-span3">
            {(id) => (
              <EntityLookup
                id={id}
                aria-label={t("customer")}
                entityLabel={party.entityLabel}
                fetcher={gridFetcher("core.party")}
                fields={party.fields}
                baseFilters={[{ field: "kind", op: "eq", value: "customer" }]}
                forInvoice
                disabled={readOnly || !isNew}
                value={draft.partyId ? { id: draft.partyId, label: draft.partyLabel } : null}
                href={party.linkable && draft.partyId ? recordHref("core.party", draft.partyId) : null}
                describe={partyRow}
                onPick={(row) => setDraft((d) => ({ ...d, partyId: row?.id ?? "", partyLabel: row ? String(row.legal_name ?? row.id) : "" }))}
              />
            )}
          </Field>
          {kind === "quote" && opportunity && (
            <Field label={t("opportunity")} hint={t("opportunity_hint")} error={failed.field("opportunityId")} className="erp-span3">
              {(id) => (
                <EntityLookup
                  id={id}
                  aria-label={t("opportunity")}
                  entityLabel={opportunity.entityLabel}
                  fetcher={gridFetcher("crm.opportunity")}
                  fields={opportunity.fields}
                  baseFilters={[{ field: "outcome", op: "eq", value: "open" }, ...(draft.partyId ? [{ field: "party_id", op: "eq" as const, value: draft.partyId }] : [])]}
                  disabled={readOnly || !isNew}
                  value={draft.opportunityId ? { id: draft.opportunityId, label: draft.opportunityLabel } : null}
                  href={opportunity.linkable && draft.opportunityId ? recordHref("crm.opportunity", draft.opportunityId) : null}
                  describe={(row) => ({ label: `${String(row.number ?? "")} · ${String(row.title ?? "")}`, sub: String(row.party_id_label ?? "") })}
                  onPick={(row) => setDraft((d) => ({ ...d, opportunityId: row?.id ?? "", opportunityLabel: row ? `${String(row.number ?? "")} · ${String(row.title ?? "")}` : "" }))}
                />
              )}
            </Field>
          )}
          <DateField label={t("issue_date")} value={draft.issueDate} disabled={readOnly || !isNew} error={failed.field("issueDate")} onChange={set("issueDate")} />
          {kind === "invoice" ? (
            <>
              {isMasked("payment_form") ? (
                <MaskedField label={ti("payment_form")} />
              ) : (
                <SelectField label={ti("payment_form")} hint={ti("payment_form_hint")} value={draft.paymentForm} options={[{ code: "1", name: ti("payment_form_1") }, { code: "2", name: ti("payment_form_2") }]} showCode={false} empty="—" disabled={readOnly} error={failed.field("paymentForm")} onChange={set("paymentForm")} />
              )}
              {isMasked("payment_means") ? (
                <MaskedField label={ti("payment_means")} />
              ) : (
                <SelectField label={ti("payment_means")} value={draft.paymentMeans} options={paymentMeans} empty="—" disabled={readOnly} error={failed.field("paymentMeans")} onChange={set("paymentMeans")} />
              )}
              {isMasked("due_date") ? <MaskedField label={ti("due_date")} /> : <DateField label={ti("due_date")} value={draft.dueDate} disabled={readOnly} error={failed.field("dueDate")} onChange={set("dueDate")} />}
            </>
          ) : kind === "quote" ? (
            isMasked("valid_until") ? <MaskedField label={t("valid_until")} /> : <DateField label={t("valid_until")} value={draft.validUntil} disabled={readOnly} error={failed.field("validUntil")} onChange={set("validUntil")} />
          ) : (
            <>
              {isMasked("delivery_date") ? <MaskedField label={t("delivery_date")} /> : <DateField label={t("delivery_date")} value={draft.deliveryDate} disabled={readOnly} error={failed.field("deliveryDate")} onChange={set("deliveryDate")} />}
              {isMasked("warehouse_id") ? (
                <MaskedField label={t("warehouse")} />
              ) : (
                <SelectField label={t("warehouse")} hint={t("warehouse_hint")} value={draft.warehouseId} options={warehouses} showCode={false} empty="—" disabled={readOnly} error={failed.field("warehouseId")} onChange={set("warehouseId")} />
              )}
            </>
          )}
          {isMasked("notes") ? <MaskedField label={t("notes")} /> : <AreaField label={t("notes")} value={draft.notes} disabled={readOnly} onChange={set("notes")} />}
        </div>
        {kind === "quote" && isNew && <p className="erp-small erp-muted">{t("validity_hint")}</p>}
      </Section>
      <Section title={t("lines")}>
        <div className="erp-lines__scroll">
          <table className="erp-lines__table" aria-label={t("lines")}>
            <thead>
              <tr>
                <th scope="col" className="erp-lines__no">#</th>
                <th scope="col">{t("product")}</th>
                <th scope="col" className="erp-num">{t("qty")}</th>
                <th scope="col" className="erp-num">{t("unit_price")}</th>
                <th scope="col" className="erp-num">{t("discount_pct")}</th>
                <th scope="col">{t("description")}</th>
                <th scope="col"><span className="sr-only">{t("remove_line")}</span></th>
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l, i) => {
                const n = i + 1;
                return (
                  <tr key={l.key}>
                    <td className="erp-lines__no erp-muted">{n}</td>
                    <td style={{ minWidth: 280 }}>
                      <EntityLookup
                        aria-label={t("product_line", { n })}
                        entityLabel={product.entityLabel}
                        fetcher={productFetcher}
                        fields={product.fields}
                        baseFilters={[{ field: "is_active", op: "eq", value: true }]}
                        forInvoice
                        disabled={linesLocked}
                        value={l.productId ? { id: l.productId, label: l.productLabel } : null}
                        href={product.linkable && l.productId ? recordHref("core.product", l.productId) : null}
                        describe={(row: GridRow) => ({ label: productRow(row), sub: String(row.uom_code ?? "") })}
                        onPick={(row) => setLine(l.key, { productId: row?.id ?? "", productLabel: row ? productRow(row) : "" })}
                      />
                    </td>
                    <td className="erp-num">
                      <input aria-label={t("qty_line", { n })} className="erp-num erp-mono" inputMode="decimal" value={l.qty} disabled={linesLocked} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                    </td>
                    <td className="erp-num">
                      <input aria-label={t("unit_price_line", { n })} className="erp-num erp-mono" inputMode="decimal" placeholder={t("from_list")} value={l.unitPrice} disabled={linesLocked} onChange={(e) => setLine(l.key, { unitPrice: e.target.value })} />
                    </td>
                    <td className="erp-num">
                      <input aria-label={t("discount_line", { n })} className="erp-num erp-mono" inputMode="decimal" placeholder={t("customer_discount")} value={l.discountPct} disabled={linesLocked} onChange={(e) => setLine(l.key, { discountPct: e.target.value })} />
                    </td>
                    <td>
                      <input aria-label={t("description_line", { n })} value={l.description} maxLength={300} disabled={linesLocked} onChange={(e) => setLine(l.key, { description: e.target.value })} />
                    </td>
                    <td>
                      {l.productId !== "" && !linesLocked && (
                        <button type="button" className="erp-btn erp-btn--ghost" aria-label={t("remove_line_n", { n })} onClick={() => removeLine(l.key)}>
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="erp-small erp-muted">{linesFixed ? ti("lines_from_sale") : t(linesLocked && !readOnly ? "lines_masked" : "pricing_hint")}</p>
      </Section>
      <FormFooter flow={flow} missing={missing} missingText={(m) => t(`missing_field.${m}`)} process={isNew ? processes.create : processes.update} isNew={isNew} dirty={dirty} readOnly={readOnly} onSave={submit} onDiscard={discard} panel={failed.panel} />
    </RecordForm>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------

export interface FulfilFormProps extends CommonProps {
  kind: "delivery" | "return";
  today: string;
  /** An entrega's bodegas (default: the pedido's). */
  warehouses?: readonly CodeOption[];
  /** The pedidos (entrega) or the entregas (devolución) it can come from. */
  source: LookupSource;
  initial?: Readonly<Record<string, unknown>> | null;
}

/**
 * A new entrega of a confirmed pedido, or a new devolución of a shipped entrega: the source document, then its lines with how much of
 * each goes (empty: everything left, the process counts what the other entregas or devoluciones took).
 */
export function FulfilForm({ kind, today, warehouses = [], source, initial: copy, readOnly = false, save, requestStepUp, onSaved, processes }: FulfilFormProps) {
  const t = useTranslations("sales.form");
  const errorText = useErrorText();
  const [initial] = useState(() => fulfilDraft(today, copy ?? null));
  const [draft, setDraft] = useState<FulfilDraft>(initial);
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, true));
  const failed = failureMessages(flow.failure, ["orderId", "deliveryId", "date", "warehouseId", "reason", "notes"], errorText);
  const missing = fulfilMissing(kind, draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const send = () => flow.submit(fulfilInput(kind, draft));
  const submit = () => void send();
  const sourceEntity = kind === "delivery" ? "sales.order" : "sales.delivery";
  const linesEntity = kind === "delivery" ? "sales.order_line" : "sales.delivery_line";
  const parentField = kind === "delivery" ? "order_id" : "delivery_id";
  const sourceId = draft.sourceId;
  // The lines of the chosen source, read through its lines grid (rule 20: the caller's masks apply).
  useEffect(() => {
    if (!sourceId) return;
    const controller = new AbortController();
    gridFetcher(linesEntity)({ filters: [{ field: parentField, op: "eq", value: sourceId }], sort: [{ field: "line_no", dir: "asc" }], page: 1, pageSize: 200 }, controller.signal)
      .then((page) =>
        setDraft((d) =>
          d.sourceId !== sourceId
            ? d
            : {
                ...d,
                lines: page.rows.map((r) => ({
                  lineId: r.id,
                  lineNo: Number(r.line_no),
                  label: String(r.product_id_label ?? r.description ?? r.product_id ?? ""),
                  sourceQty: Number(r.qty ?? 0),
                  qty: "",
                })),
              },
        ),
      )
      .catch(() => {});
    return () => controller.abort();
  }, [sourceId, linesEntity, parentField]);
  const set = <K extends keyof FulfilDraft>(k: K) => (value: FulfilDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));

  return (
    <RecordForm canSave={!readOnly && missing.length === 0 && !flow.saving && !flow.stepUp} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure}>
      <Section title={t(`section.${kind}`)}>
        <div className="erp-form2">
          <Field label={`${t(kind === "delivery" ? "order" : "delivery")} *`} hint={t(kind === "delivery" ? "order_hint" : "delivery_hint")} error={failed.field(kind === "delivery" ? "orderId" : "deliveryId")} className="erp-span3">
            {(id) => (
              <EntityLookup
                id={id}
                aria-label={t(kind === "delivery" ? "order" : "delivery")}
                entityLabel={source.entityLabel}
                fetcher={gridFetcher(sourceEntity)}
                fields={source.fields}
                baseFilters={kind === "delivery" ? [{ field: "stage", op: "in", value: ["confirmed", "partially_delivered"] }] : [{ field: "stage", op: "eq", value: "shipped" }, { field: "status", op: "eq", value: "saved" }]}
                disabled={readOnly}
                value={draft.sourceId ? { id: draft.sourceId, label: draft.sourceLabel } : null}
                href={source.linkable && draft.sourceId ? recordHref(sourceEntity, draft.sourceId) : null}
                describe={(row: GridRow) => ({ label: String(row.number ?? row.id), sub: String(row.party_id_label ?? "") })}
                onPick={(row) => setDraft((d) => ({ ...d, sourceId: row?.id ?? "", sourceLabel: row ? String(row.number ?? row.id) : "", lines: [] }))}
              />
            )}
          </Field>
          <DateField label={t("date")} value={draft.date} disabled={readOnly} error={failed.field("date")} onChange={set("date")} />
          {kind === "delivery" && <SelectField label={t("warehouse")} hint={t("delivery_warehouse_hint")} value={draft.warehouseId} options={warehouses} showCode={false} empty="—" disabled={readOnly} error={failed.field("warehouseId")} onChange={set("warehouseId")} />}
          {kind === "return" && <TextField label={`${t("reason")} *`} value={draft.reason} maxLength={500} disabled={readOnly} error={failed.field("reason")} onChange={set("reason")} className="erp-span3" />}
          <AreaField label={t("notes")} value={draft.notes} disabled={readOnly} onChange={set("notes")} />
        </div>
      </Section>
      {draft.lines.length > 0 && (
        <Section title={t("lines")}>
          <div className="erp-lines__scroll">
            <table className="erp-lines__table" aria-label={t("lines")}>
              <thead>
                <tr>
                  <th scope="col" className="erp-lines__no">#</th>
                  <th scope="col">{t("product")}</th>
                  <th scope="col" className="erp-num">{t(kind === "delivery" ? "ordered_qty" : "delivered_qty")}</th>
                  <th scope="col" className="erp-num">{t(kind === "delivery" ? "deliver_qty" : "return_qty")}</th>
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((l) => (
                  <tr key={l.lineId}>
                    <td className="erp-lines__no erp-muted">{l.lineNo}</td>
                    <td>{l.label}</td>
                    <td className="erp-num erp-mono">{l.sourceQty}</td>
                    <td className="erp-num">
                      <input aria-label={t("fulfil_line", { n: l.lineNo })} className="erp-num erp-mono" inputMode="decimal" placeholder={t("all_left")} value={l.qty} disabled={readOnly} onChange={(e) => setDraft((d) => ({ ...d, lines: d.lines.map((x) => (x.lineId === l.lineId ? { ...x, qty: e.target.value } : x)) }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="erp-small erp-muted">{t(kind === "delivery" ? "deliver_hint" : "return_hint")}</p>
        </Section>
      )}
      <FormFooter flow={flow} missing={missing} missingText={(m) => t(`missing_field.${m}`)} process={processes.create} isNew dirty={dirty} readOnly={readOnly} onSave={submit} panel={failed.panel} />
    </RecordForm>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------

export interface LeadFormProps extends CommonProps {
  record: Row | null;
  initial?: Readonly<Record<string, unknown>> | null;
  documentTypes: readonly CodeOption[];
  /** Extra content under the form (the Convertir panel of a stored prospecto). */
  footer?: ReactNode;
}

export function LeadForm({ record, initial: copy, documentTypes, footer, readOnly = false, save, requestStepUp, onSaved, processes }: LeadFormProps) {
  const t = useTranslations("crm.form");
  const tv = useTranslations("crm.values");
  const errorText = useErrorText();
  const isNew = record === null;
  const converted = record?.stage === "converted";
  const locked = readOnly || converted;
  const key = record ? `${record.id}:${String(record.updated_at ?? "")}` : "new";
  const [draft, initial, setDraft, discard] = useDraft<LeadDraft>(key, () => leadDraft(record ?? copy ?? null));
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, isNew));
  const fields = ["name", "contactName", "email", "phoneCc", "phone", "personType", "documentType", "documentNumber", "source", "stage", "notes"];
  const failed = failureMessages(flow.failure, fields, errorText);
  const missing = leadMissing(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const send = () => flow.submit(leadInput(draft, record ? record.id : null));
  const submit = () => void send();
  const set = <K extends keyof LeadDraft>(k: K) => (value: LeadDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const personTypes = [{ code: "1", name: t("person_type_1") }, { code: "2", name: t("person_type_2") }];
  return (
    <RecordForm canSave={!locked && missing.length === 0 && !flow.saving && !flow.stepUp && (dirty || isNew)} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure} {...(isNew ? {} : { onDiscard: discard })}>
      <Section title={t("section.lead")}>
        <div className="erp-form2">
          <TextField label={`${t("name")} *`} value={draft.name} maxLength={160} disabled={locked} error={failed.field("name")} onChange={set("name")} className="erp-span3" />
          <TextField label={t("contact")} value={draft.contactName} maxLength={120} disabled={locked} error={failed.field("contactName")} onChange={set("contactName")} />
          <TextField label={t("email")} value={draft.email} maxLength={200} disabled={locked} error={failed.field("email")} onChange={set("email")} />
          <TextField label={t("phone_cc")} value={draft.phoneCc} maxLength={4} inputMode="numeric" disabled={locked} error={failed.field("phoneCc")} onChange={set("phoneCc")} />
          <TextField label={t("phone")} value={draft.phone} maxLength={15} inputMode="numeric" disabled={locked} error={failed.field("phone")} onChange={set("phone")} />
          <SelectField label={t("source")} value={draft.source} options={LEAD_SOURCE_OPTIONS.map((c) => ({ code: c, name: tv(`lead_source.${c}`) }))} showCode={false} disabled={locked} error={failed.field("source")} onChange={set("source")} />
          {!isNew && (
            <SelectField
              label={t("stage")}
              value={draft.stage}
              options={(converted ? ["converted"] : MANUAL_LEAD_STAGES).map((c) => ({ code: c, name: tv(`lead_stage.${c}`) }))}
              showCode={false}
              disabled={locked}
              error={failed.field("stage")}
              onChange={set("stage")}
            />
          )}
          <SelectField label={t("person_type")} value={draft.personType} options={personTypes} showCode={false} empty="—" disabled={locked} error={failed.field("personType")} onChange={set("personType")} />
          <SelectField label={t("document_type")} value={draft.documentType} options={documentTypes} empty="—" disabled={locked} error={failed.field("documentType")} onChange={set("documentType")} />
          <TextField label={t("document_number")} value={draft.documentNumber} maxLength={20} mono disabled={locked} error={failed.field("documentNumber")} onChange={set("documentNumber")} />
          <AreaField label={t("notes")} value={draft.notes} disabled={locked} onChange={set("notes")} />
        </div>
        <div className="erp-flags" role="group" aria-label={t("section.lead")}>
          <Flag on={draft.isActive} label={t("active")} disabled={locked} onChange={set("isActive")} />
        </div>
      </Section>
      <FormFooter flow={flow} missing={missing} missingText={(m) => t(`missing_field.${m}`)} process={isNew ? processes.create : processes.update} isNew={isNew} dirty={dirty} readOnly={locked} onSave={submit} onDiscard={discard} panel={failed.panel} />
      {footer}
    </RecordForm>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------

export interface PipelineFormProps extends CommonProps {
  record: Row | null;
  stages?: readonly Record<string, unknown>[];
  initial?: Readonly<Record<string, unknown>> | null;
  /** The embudo a copy comes from: its etapas are copied (as new ones). */
  copyOf?: string | null;
}

export function PipelineForm({ record, stages = [], initial: copy, copyOf = null, readOnly = false, save, requestStepUp, onSaved, processes }: PipelineFormProps) {
  const t = useTranslations("crm.form");
  const tv = useTranslations("crm.values");
  const errorText = useErrorText();
  const isNew = record === null;
  const key = record ? `${record.id}:${String(record.updated_at ?? "")}` : "new";
  const [draft, initial, setDraft, discard] = useDraft<PipelineDraft>(key, () => pipelineDraft(record ?? copy ?? null, record ? stages : []));
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, isNew));
  const failed = failureMessages(flow.failure, ["code", "name", "description"], errorText);
  const missing = pipelineMissing(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const send = () => flow.submit(pipelineInput(draft, record ? record.id : null));
  const submit = () => void send();
  const set = <K extends keyof PipelineDraft>(k: K) => (value: PipelineDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  useCopiedLines("crm.stage", "pipeline_id", isNew ? copyOf : null, (rows) => {
    if (rows.length === 0) return;
    // The copy's etapas are new ones: no ids (the process creates them).
    setDraft((d) => ({ ...d, stages: pipelineDraft({ id: "copy" }, rows).stages.map((st) => ({ ...st, id: "" })) }));
  });
  const setStage = (k: string, patch: Partial<StageDraft>) => setDraft((d) => ({ ...d, stages: d.stages.map((st) => (st.key === k ? { ...st, ...patch } : st)) }));
  const move = (k: string, step: -1 | 1) =>
    setDraft((d) => {
      const i = d.stages.findIndex((st) => st.key === k);
      const j = i + step;
      if (i < 0 || j < 0 || j >= d.stages.length) return d;
      const next = [...d.stages];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...d, stages: next };
    });
  return (
    <RecordForm canSave={!readOnly && missing.length === 0 && !flow.saving && !flow.stepUp && (dirty || isNew)} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure} {...(isNew ? {} : { onDiscard: discard })}>
      <Section title={t("section.pipeline")}>
        <div className="erp-form2">
          <TextField label={`${t("code")} *`} value={draft.code} mono maxLength={20} disabled={readOnly} error={failed.field("code")} onChange={set("code")} />
          <TextField label={`${t("name")} *`} value={draft.name} maxLength={120} disabled={readOnly} error={failed.field("name")} onChange={set("name")} />
          <AreaField label={t("description")} value={draft.description} maxLength={500} disabled={readOnly} onChange={set("description")} />
        </div>
        <div className="erp-flags" role="group" aria-label={t("section.pipeline")}>
          {isNew && <Flag on={draft.isDefault} label={t("is_default")} disabled={readOnly} onChange={set("isDefault")} />}
          <Flag on={draft.isActive} label={t("active")} disabled={readOnly} onChange={set("isActive")} />
        </div>
      </Section>
      <Section title={t("stages")}>
        <div className="erp-lines__scroll">
          <table className="erp-lines__table" aria-label={t("stages")}>
            <thead>
              <tr>
                <th scope="col" className="erp-lines__no">#</th>
                <th scope="col">{t("stage_name")}</th>
                <th scope="col" className="erp-num">{t("probability")}</th>
                <th scope="col">{t("stage_kind")}</th>
                <th scope="col"><span className="sr-only">{t("reorder")}</span></th>
              </tr>
            </thead>
            <tbody>
              {draft.stages.map((st, i) => {
                const n = i + 1;
                return (
                  <tr key={st.key}>
                    <td className="erp-lines__no erp-muted">{n}</td>
                    <td><input aria-label={t("stage_name_line", { n })} value={st.name} maxLength={80} disabled={readOnly} onChange={(e) => setStage(st.key, { name: e.target.value })} /></td>
                    <td className="erp-num"><input aria-label={t("probability_line", { n })} className="erp-num erp-mono" inputMode="decimal" value={st.probability} disabled={readOnly || st.kind !== "open"} onChange={(e) => setStage(st.key, { probability: e.target.value })} /></td>
                    <td>
                      <select aria-label={t("stage_kind_line", { n })} value={st.kind} disabled={readOnly} onChange={(e) => setStage(st.key, { kind: e.target.value, ...(e.target.value === "won" ? { probability: "100" } : e.target.value === "lost" ? { probability: "0" } : {}) })}>
                        {STAGE_KIND_OPTIONS.map((k) => <option key={k} value={k}>{tv(`stage_kind.${k}`)}</option>)}
                      </select>
                    </td>
                    <td className="erp-row">
                      {!readOnly && (
                        <>
                          <button type="button" className="erp-btn erp-btn--ghost" aria-label={t("move_up", { n })} disabled={i === 0} onClick={() => move(st.key, -1)}>↑</button>
                          <button type="button" className="erp-btn erp-btn--ghost" aria-label={t("move_down", { n })} disabled={i === draft.stages.length - 1} onClick={() => move(st.key, 1)}>↓</button>
                          <button type="button" className="erp-btn erp-btn--ghost" aria-label={t("remove_stage", { n })} disabled={draft.stages.length <= 3} onClick={() => setDraft((d) => ({ ...d, stages: d.stages.filter((x) => x.key !== st.key) }))}>×</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!readOnly && (
          <button type="button" className="erp-btn" onClick={() => setDraft((d) => ({ ...d, stages: [...d.stages, emptyStage()] }))}>
            {t("add_stage")}
          </button>
        )}
        <p className="erp-small erp-muted">{t("stages_hint")}</p>
      </Section>
      <FormFooter flow={flow} missing={missing} missingText={(m) => t(`missing_field.${m}`)} process={isNew ? processes.create : processes.update} isNew={isNew} dirty={dirty} readOnly={readOnly} onSave={submit} onDiscard={discard} panel={failed.panel} />
    </RecordForm>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------

export interface OpportunityFormProps extends CommonProps {
  pipelines: readonly CodeOption[];
  party: LookupSource;
  lead: LookupSource | null;
  product: LookupSource;
  initial?: Readonly<Record<string, unknown>> | null;
  labels?: Readonly<Record<string, string>>;
}

/** A new oportunidad (it never changes but through its etapas, Reasignar and Anular). */
export function OpportunityForm({ pipelines, party, lead, product, initial: copy, labels = {}, readOnly = false, save, requestStepUp, onSaved, processes }: OpportunityFormProps) {
  const t = useTranslations("crm.form");
  const errorText = useErrorText();
  const [initial] = useState(() => opportunityDraft(copy ?? null, labels));
  const [draft, setDraft] = useState<OpportunityDraft>(initial);
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, true));
  const failed = failureMessages(flow.failure, ["title", "partyId", "leadId", "pipelineId", "amount", "expectedClose", "description"], errorText);
  const missing = opportunityMissing(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const send = () => flow.submit(opportunityInput(draft));
  const submit = () => void send();
  const set = <K extends keyof OpportunityDraft>(k: K) => (value: OpportunityDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const setLine = (k: string, patch: Partial<OpportunityLine>) =>
    setDraft((d) => {
      const next = d.lines.map((l) => (l.key === k ? { ...l, ...patch } : l));
      const last = next.at(-1);
      return { ...d, lines: last && (last.productId !== "" || last.description.trim() !== "") ? [...next, emptyOpportunityLine()] : next };
    });
  return (
    <RecordForm canSave={!readOnly && missing.length === 0 && !flow.saving && !flow.stepUp} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure}>
      <Section title={t("section.opportunity")}>
        <div className="erp-form2">
          <TextField label={`${t("title")} *`} value={draft.title} maxLength={160} disabled={readOnly} error={failed.field("title")} onChange={set("title")} className="erp-span3" />
          <Field label={t("customer")} hint={t("party_or_lead_hint")} error={failed.field("partyId")} className="erp-span3">
            {(id) => (
              <EntityLookup
                id={id}
                aria-label={t("customer")}
                entityLabel={party.entityLabel}
                fetcher={gridFetcher("core.party")}
                fields={party.fields}
                baseFilters={[{ field: "kind", op: "eq", value: "customer" }]}
                disabled={readOnly}
                value={draft.partyId ? { id: draft.partyId, label: draft.partyLabel } : null}
                href={party.linkable && draft.partyId ? recordHref("core.party", draft.partyId) : null}
                describe={partyRow}
                onPick={(row) => setDraft((d) => ({ ...d, partyId: row?.id ?? "", partyLabel: row ? String(row.legal_name ?? row.id) : "" }))}
              />
            )}
          </Field>
          {lead && (
            <Field label={t("lead")} error={failed.field("leadId")} className="erp-span3">
              {(id) => (
                <EntityLookup
                  id={id}
                  aria-label={t("lead")}
                  entityLabel={lead.entityLabel}
                  fetcher={gridFetcher("crm.lead")}
                  fields={lead.fields}
                  disabled={readOnly}
                  value={draft.leadId ? { id: draft.leadId, label: draft.leadLabel } : null}
                  href={lead.linkable && draft.leadId ? recordHref("crm.lead", draft.leadId) : null}
                  describe={(row) => ({ label: String(row.name ?? row.id), sub: String(row.contact_name ?? "") })}
                  onPick={(row) => setDraft((d) => ({ ...d, leadId: row?.id ?? "", leadLabel: row ? String(row.name ?? row.id) : "" }))}
                />
              )}
            </Field>
          )}
          <SelectField label={t("pipeline")} hint={t("pipeline_hint")} value={draft.pipelineId} options={pipelines} showCode={false} empty={t("default_pipeline")} disabled={readOnly} error={failed.field("pipelineId")} onChange={set("pipelineId")} />
          <TextField label={t("amount")} hint={t("amount_hint")} value={draft.amount} inputMode="decimal" disabled={readOnly} error={failed.field("amount")} onChange={set("amount")} />
          <DateField label={t("expected_close")} value={draft.expectedClose} disabled={readOnly} error={failed.field("expectedClose")} onChange={set("expectedClose")} />
          <AreaField label={t("description")} value={draft.description} maxLength={500} disabled={readOnly} onChange={set("description")} />
        </div>
      </Section>
      <Section title={t("opportunity_lines")}>
        <div className="erp-lines__scroll">
          <table className="erp-lines__table" aria-label={t("opportunity_lines")}>
            <thead>
              <tr>
                <th scope="col" className="erp-lines__no">#</th>
                <th scope="col">{t("product")}</th>
                <th scope="col">{t("description")}</th>
                <th scope="col" className="erp-num">{t("qty")}</th>
                <th scope="col" className="erp-num">{t("unit_price")}</th>
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l, i) => {
                const n = i + 1;
                return (
                  <tr key={l.key}>
                    <td className="erp-lines__no erp-muted">{n}</td>
                    <td style={{ minWidth: 240 }}>
                      <EntityLookup
                        aria-label={t("product_line", { n })}
                        entityLabel={product.entityLabel}
                        fetcher={gridFetcher("core.product")}
                        fields={product.fields}
                        disabled={readOnly}
                        value={l.productId ? { id: l.productId, label: l.productLabel } : null}
                        describe={(row: GridRow) => ({ label: productRow(row) })}
                        onPick={(row) => setLine(l.key, { productId: row?.id ?? "", productLabel: row ? productRow(row) : "" })}
                      />
                    </td>
                    <td><input aria-label={t("description_line", { n })} value={l.description} maxLength={300} disabled={readOnly} onChange={(e) => setLine(l.key, { description: e.target.value })} /></td>
                    <td className="erp-num"><input aria-label={t("qty_line", { n })} className="erp-num erp-mono" inputMode="decimal" value={l.qty} disabled={readOnly} onChange={(e) => setLine(l.key, { qty: e.target.value })} /></td>
                    <td className="erp-num"><input aria-label={t("unit_price_line", { n })} className="erp-num erp-mono" inputMode="decimal" value={l.unitPrice} disabled={readOnly} onChange={(e) => setLine(l.key, { unitPrice: e.target.value })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
      <FormFooter flow={flow} missing={missing} missingText={(m) => t(`missing_field.${m}`)} process={processes.create} isNew dirty={dirty} readOnly={readOnly} onSave={submit} panel={failed.panel} />
    </RecordForm>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------

export interface ActivityFormProps extends CommonProps {
  party: LookupSource;
  lead: LookupSource | null;
  opportunity: LookupSource | null;
  initial?: Readonly<Record<string, unknown>> | null;
  labels?: Readonly<Record<string, string>>;
}

/** A new actividad (sistema: it is logged, never edited). */
export function ActivityForm({ party, lead, opportunity, initial: copy, labels = {}, readOnly = false, save, requestStepUp, onSaved, processes }: ActivityFormProps) {
  const t = useTranslations("crm.form");
  const tv = useTranslations("crm.values");
  const errorText = useErrorText();
  const [initial] = useState(() => activityDraft(copy ?? null, labels));
  const [draft, setDraft] = useState<ActivityDraft>(initial);
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, true));
  const failed = failureMessages(flow.failure, ["kind", "subject", "notes", "opportunityId", "leadId", "partyId", "dueAt"], errorText);
  const missing = activityMissing(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const send = () => flow.submit(activityInput(draft));
  const submit = () => void send();
  const set = <K extends keyof ActivityDraft>(k: K) => (value: ActivityDraft[K]) => setDraft((d) => ({ ...d, [k]: value }));
  const lookup = (label: string, source: LookupSource | null, entity: string, idKey: "opportunityId" | "leadId" | "partyId", labelKey: "opportunityLabel" | "leadLabel" | "partyLabel", describe: (row: GridRow) => string) =>
    source && (
      <Field label={label} error={failed.field(idKey)} className="erp-span3">
        {(id) => (
          <EntityLookup
            id={id}
            aria-label={label}
            entityLabel={source.entityLabel}
            fetcher={gridFetcher(entity)}
            fields={source.fields}
            disabled={readOnly}
            value={draft[idKey] ? { id: draft[idKey], label: draft[labelKey] } : null}
            href={source.linkable && draft[idKey] ? recordHref(entity, draft[idKey]) : null}
            describe={(row) => ({ label: describe(row) })}
            onPick={(row) => setDraft((d) => ({ ...d, [idKey]: row?.id ?? "", [labelKey]: row ? describe(row) : "" }))}
          />
        )}
      </Field>
    );
  return (
    <RecordForm canSave={!readOnly && missing.length === 0 && !flow.saving && !flow.stepUp} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure}>
      <Section title={t("section.activity")}>
        <div className="erp-form2">
          <SelectField label={t("activity_kind")} value={draft.kind} options={ACTIVITY_KIND_OPTIONS.map((k) => ({ code: k, name: tv(`activity_kind.${k}`) }))} showCode={false} disabled={readOnly} error={failed.field("kind")} onChange={set("kind")} />
          <TextField label={`${t("subject")} *`} value={draft.subject} maxLength={200} disabled={readOnly} error={failed.field("subject")} onChange={set("subject")} className="erp-span3" />
          {lookup(t("opportunity"), opportunity, "crm.opportunity", "opportunityId", "opportunityLabel", (row) => `${String(row.number ?? "")} · ${String(row.title ?? "")}`)}
          {lookup(t("lead"), lead, "crm.lead", "leadId", "leadLabel", (row) => String(row.name ?? row.id))}
          {lookup(t("party"), party, "core.party", "partyId", "partyLabel", (row) => String(row.legal_name ?? row.id))}
          <DateField label={t("due_date")} value={draft.dueDate} disabled={readOnly} error={failed.field("dueAt")} onChange={set("dueDate")} />
          <AreaField label={t("notes")} value={draft.notes} disabled={readOnly} onChange={set("notes")} />
        </div>
        <div className="erp-flags" role="group" aria-label={t("section.activity")}>
          <Flag on={draft.done} label={t("done")} disabled={readOnly} onChange={set("done")} />
        </div>
        <p className="erp-small erp-muted">{t("about_hint")}</p>
      </Section>
      <FormFooter flow={flow} missing={missing} missingText={(m) => t(`missing_field.${m}`)} process={processes.create} isNew dirty={dirty} readOnly={readOnly} onSave={submit} panel={failed.panel} />
    </RecordForm>
  );
}
