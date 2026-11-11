"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRecordBridge } from "../record/record-bridge";
import { RecordForm, SAVE_SHORTCUTS, Section, SelectField, TextField, Field, failureMessages, useErrorText } from "../forms/form-parts";
import { ProcessId } from "../forms/ProcessId";
import type { CodeOption, RequestStepUp, SaveRecord } from "../forms/save-model";
import { StepUpPrompt } from "../forms/StepUpPrompt";
import { useSaveFlow } from "../forms/use-save";
import { gridFetcher } from "../grid/fetch-grid";
import type { GridColumn, GridRow } from "../grid/types";
import { EntityLookup } from "../lookup/EntityLookup";
import { recordHref } from "../record/record-model";
import { RecordLink } from "../record/RecordLink";
import {
  createProcess,
  emptyLine,
  FORM_LANDED_BASES,
  FORM_MOVEMENT_KINDS,
  FORM_OFFSET_ROLES,
  masterStockCopy,
  masterStockDraft,
  masterStockInput,
  masterStockMissing,
  OWED_ROLES,
  parseQty,
  stockDraft,
  stockInput,
  stockMissing,
  type StockDraft,
  type StockFormKind,
  type StockLine,
  type StockMasterKind,
} from "./stock-form-model";

// The Datos tab of the inventory and costing records (plan 2B Task 10): a bodega or ubicación (maestros, saved through their create and
// update processes) and the new movimiento, traslado, conteo and costo en destino. Each saves through the process that creates it (an
// ajuste through inventory.adjustment.post, which asks for the step-up code here, rule 15); the record frame's Guardar runs the save.
// Task 28.5: the lote and the serial (maestros) and the seguimiento por producto (parametro, inventory.product_tracking.set, step-up) edit
// in place through the same master form.

/** A ubicación as a select option, with its bodega (a line offers only the ubicaciones of the line's bodega). */
export interface LocationOption extends CodeOption {
  warehouseId: string;
}

/** What a lookup box needs from the server: the entity's fields (the advanced filter) and its name. */
export interface LookupSource {
  fields: readonly GridColumn[];
  entityLabel: string;
  /** The viewer may open the entity's records (rule 21): the chosen record links to its page. */
  linkable?: boolean;
}

export interface StockMasterFormProps {
  kind: StockMasterKind;
  record: (Record<string, unknown> & { id: string }) | null;
  initial?: Readonly<Record<string, unknown>> | null;
  readOnly?: boolean;
  /** The bodegas a new ubicación can belong to. */
  warehouses?: readonly CodeOption[];
  processes: { create: string; update: string };
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  onSaved?: (id: string, created: boolean) => void;
  /** How the record's (or the copy's) references read to the caller, by field (`product_id`, `lot_id`). */
  labels?: Readonly<Record<string, string>>;
  /** A lote: the products tracked by lot; a serial: those tracked by serial (Task 28.5). */
  products?: readonly CodeOption[];
  /** A serial: the lots of each of those products, by product id. */
  lots?: Readonly<Record<string, readonly CodeOption[]>>;
  /** The product box of a seguimiento; its `linkable` also links the product of a stored lote, serial or seguimiento (rule 21). */
  product?: LookupSource;
}

/** The record's fields the process refusals may name, by input key. */
const MASTER_FIELD_KEYS = ["code", "name", "addressLine", "warehouseId", "kind", "productId", "serialNo", "lotId", "expiresOn", "producedOn", "status", "note", "tracking"];

export function StockMasterForm({ kind, record, initial: copy, readOnly = false, warehouses = [], processes, save, requestStepUp, onSaved, labels = {}, products = [], lots = {}, product }: StockMasterFormProps) {
  const t = useTranslations("inventory.form");
  const tv = useTranslations("inventory.values");
  const tf = useTranslations("common.forms");
  const tc = useTranslations("common");
  const errorText = useErrorText();
  const bridge = useRecordBridge();
  const isNew = record === null;
  const recordKey = record ? `${record.id}:${String(record.updated_at ?? "")}` : "new";
  const tracked = kind === "lot" || kind === "serial" || kind === "tracking";
  // «Duplicar» of a lote or serial starts from the source's product, dates and note, the code or number cleared (rule 37).
  const fresh = () => (record ? masterStockDraft(record, labels) : copy && (kind === "lot" || kind === "serial") ? masterStockCopy(copy, labels) : masterStockDraft(copy ?? null, labels));
  const [seen, setSeen] = useState(recordKey);
  const [initial, setInitial] = useState(fresh);
  const [draft, setDraft] = useState(initial);
  if (seen !== recordKey) {
    const next = fresh();
    setSeen(recordKey);
    setInitial(next);
    setDraft(next);
  }
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, isNew));
  const failed = failureMessages(flow.failure, MASTER_FIELD_KEYS, errorText);
  const missingKeys: string[] = tracked ? masterStockMissing(kind, draft, isNew) : masterStockMissing(kind, draft, isNew) ? ["master"] : [];
  const missing = missingKeys.length > 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const send = () => flow.submit(masterStockInput(kind, draft, record ? record.id : null));
  const submit = () => void send();
  const set = <K extends keyof typeof draft>(key: K) => (value: (typeof draft)[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const flag = (key: "allowBackorders" | "isActive" | "fefo" | "expiryRequired" | "blockExpired", label: string) => {
    const on = draft[key];
    return (
      <button key={key} type="button" role="switch" aria-checked={on} disabled={readOnly} className={on ? "erp-flag is-on" : "erp-flag"} onClick={() => !readOnly && set(key)(!on)}>
        <i aria-hidden="true" className="erp-flag__dot" />
        {label} <span className="erp-flag__state">{on ? tc("yes") : tc("no")}</span>
      </button>
    );
  };
  const title = tracked ? t(`${kind}.section`) : t(`section.${kind}`);
  // A stored record's product never changes: it reads as a link to the product (rule 21) when the caller may open products.
  const storedProduct = (label: string) => (
    <div className="erp-field">
      <span className="erp-field__label">{label}</span>
      {product?.linkable && draft.productId ? <RecordLink entity="core.product" id={draft.productId} label={draft.productLabel || draft.productId} /> : <span>{draft.productLabel || draft.productId || "—"}</span>}
    </div>
  );
  // The products a new lote or serial can be of (the stored or copied one stays offered even if its tracking changed since).
  const productOptions = draft.productId && !products.some((p) => p.code === draft.productId) ? [{ code: draft.productId, name: draft.productLabel || draft.productId }, ...products] : products;
  const productLots = lots[draft.productId] ?? [];

  const body = (() => {
    if (kind === "lot") {
      return (
        <div className="erp-form2">
          {isNew ? (
            <SelectField label={`${t("lot.product")} *`} hint={products.length === 0 ? t("lot.no_products") : t("lot.product_hint")} value={draft.productId} options={productOptions} showCode={false} empty="—" disabled={readOnly} error={failed.field("productId")}
              onChange={(v) => setDraft((d) => ({ ...d, productId: v, productLabel: productOptions.find((p) => p.code === v)?.name ?? "" }))} />
          ) : (
            storedProduct(t("lot.product"))
          )}
          <TextField label={`${t("lot.code")} *`} hint={t("lot.code_hint")} value={draft.code} mono maxLength={60} disabled={readOnly || !isNew} error={failed.field("code")} onChange={set("code")} />
          <DateField label={t("lot.expires_on")} value={draft.expiresOn} disabled={readOnly} error={failed.field("expiresOn")} onChange={set("expiresOn")} />
          <DateField label={t("lot.produced_on")} value={draft.producedOn} disabled={readOnly} error={failed.field("producedOn")} onChange={set("producedOn")} />
          {!isNew && (
            <SelectField label={t("lot.status")} hint={t("lot.status_hint")} value={draft.lotStatus} options={(["active", "blocked"] as const).map((code) => ({ code, name: tv(`lot_status.${code}`) }))} showCode={false} disabled={readOnly} error={failed.field("status")} onChange={set("lotStatus")} />
          )}
          <TextField label={t("lot.note")} value={draft.note} maxLength={500} disabled={readOnly} error={failed.field("note")} onChange={set("note")} className="erp-span3" />
        </div>
      );
    }
    if (kind === "serial") {
      return (
        <div className="erp-form2">
          {isNew ? (
            <SelectField label={`${t("serial.product")} *`} hint={products.length === 0 ? t("serial.no_products") : t("serial.product_hint")} value={draft.productId} options={productOptions} showCode={false} empty="—" disabled={readOnly} error={failed.field("productId")}
              onChange={(v) => setDraft((d) => ({ ...d, productId: v, productLabel: productOptions.find((p) => p.code === v)?.name ?? "", lotId: "" }))} />
          ) : (
            storedProduct(t("serial.product"))
          )}
          <TextField label={`${t("serial.serial_no")} *`} hint={t("serial.serial_no_hint")} value={draft.serialNo} mono maxLength={80} disabled={readOnly || !isNew} error={failed.field("serialNo")} onChange={set("serialNo")} />
          {isNew && productLots.length > 0 && (
            <SelectField label={t("serial.lot")} value={draft.lotId} options={productLots} showCode={false} empty={t("serial.no_lot")} disabled={readOnly} error={failed.field("lotId")} onChange={set("lotId")} />
          )}
          {!isNew && draft.lotId && (
            <div className="erp-field">
              <span className="erp-field__label">{t("serial.lot")}</span>
              <RecordLink entity="inventory.lot" id={draft.lotId} label={labels.lot_id ?? draft.lotId} mono />
            </div>
          )}
          {!isNew && (
            <div className="erp-field" data-testid="serial-status">
              <span className="erp-field__label">{t("serial.status")}</span>
              <span title={t("serial.status_hint")}>{draft.serialStatus ? tv(`serial_status.${draft.serialStatus}`) : "—"}</span>
            </div>
          )}
          <TextField label={t("serial.note")} value={draft.note} maxLength={500} disabled={readOnly} error={failed.field("note")} onChange={set("note")} className="erp-span3" />
        </div>
      );
    }
    if (kind === "tracking") {
      return (
        <div className="erp-form2">
          {isNew ? (
            <Field label={`${t("tracking.product")} *`} error={failed.field("productId")} className="erp-span3">
              {(id) => (
                <EntityLookup
                  id={id}
                  aria-label={t("tracking.product")}
                  entityLabel={product?.entityLabel ?? ""}
                  fetcher={gridFetcher("core.product")}
                  fields={product?.fields ?? []}
                  baseFilters={[{ field: "kind", op: "eq", value: "good" }, { field: "track_stock", op: "eq", value: true }]}
                  disabled={readOnly}
                  value={draft.productId ? { id: draft.productId, label: draft.productLabel } : null}
                  href={product?.linkable && draft.productId ? recordHref("core.product", draft.productId) : null}
                  describe={(row: GridRow) => ({ label: `${String(row.sku ?? "")} · ${String(row.description ?? "")}`, sub: String(row.uom_code ?? "") })}
                  onPick={(row) => setDraft((d) => ({ ...d, productId: row?.id ?? "", productLabel: row ? `${String(row.sku ?? "")} · ${String(row.description ?? "")}` : "" }))}
                />
              )}
            </Field>
          ) : (
            storedProduct(t("tracking.product"))
          )}
          <SelectField label={`${t("tracking.tracking")} *`} value={draft.tracking} options={(["none", "lot", "serial"] as const).map((code) => ({ code, name: tv(`tracking.${code}`) }))} showCode={false} disabled={readOnly} error={failed.field("tracking")} onChange={set("tracking")} />
        </div>
      );
    }
    return (
      <div className="erp-form2">
        {kind === "location" && (
          <SelectField label={`${t("warehouse")} *`} value={draft.warehouseId} options={warehouses} showCode={false} empty={isNew ? "—" : undefined} disabled={readOnly || !isNew} error={failed.field("warehouseId")} onChange={set("warehouseId")} />
        )}
        <TextField label={`${t("code")} *`} value={draft.code} mono maxLength={20} disabled={readOnly} error={failed.field("code")} onChange={set("code")} />
        <TextField label={`${t("name")} *`} value={draft.name} maxLength={120} disabled={readOnly} error={failed.field("name")} onChange={set("name")} />
        {kind === "warehouse" && <TextField label={t("address")} value={draft.addressLine} maxLength={200} disabled={readOnly} error={failed.field("addressLine")} onChange={set("addressLine")} />}
        {kind === "location" && (
          <SelectField label={t("location_kind")} value={draft.kind} options={[{ code: "storage", name: tv("location_kind.storage") }]} showCode={false} disabled={readOnly} error={failed.field("kind")} onChange={set("kind")} />
        )}
      </div>
    );
  })();

  const flags =
    kind === "warehouse" || kind === "location"
      ? [...(kind === "warehouse" ? [flag("allowBackorders", t("allow_backorders"))] : []), flag("isActive", t("active"))]
      : kind === "tracking"
        ? [flag("fefo", t("tracking.fefo")), flag("expiryRequired", t("tracking.expiry_required")), flag("blockExpired", t("tracking.block_expired"))]
        : [];
  const status = flow.saving ? tf("saving") : !missing ? "" : tracked ? `${t("missing")}: ${missingKeys.map((m) => t(`missing_field.${m}`)).join(", ")}` : t("missing_master");
  return (
    <RecordForm canSave={!readOnly && !missing && !flow.saving && !flow.stepUp && (dirty || isNew)} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure} {...(isNew ? {} : { onDiscard: () => setDraft(initial) })}>
      <Section title={title}>
        {body}
        {flags.length > 0 && (
          <div className="erp-flags" role="group" aria-label={title}>
            {flags}
          </div>
        )}
        {kind === "warehouse" && <p className="erp-small erp-muted">{t("allow_backorders_hint")}</p>}
        {kind === "tracking" && <p className="erp-small erp-muted">{t("tracking.hint")}</p>}
      </Section>
      {failed.panel.length > 0 && (
        <div className="erp-dian erp-dian--bad" role="alert" tabIndex={-1} data-error-summary="">
          <b>{failed.panel.join(" · ")}</b>
        </div>
      )}
      {!readOnly && (
        <div className="erp-form__actions">
          {flow.stepUp && <StepUpPrompt onConfirm={(code) => void flow.confirmStepUp(code)} onCancel={flow.cancelStepUp} error={flow.stepUpError} busy={flow.saving} />}
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {status} <kbd className="erp-mono">{tf("save_hint")}</kbd> · <ProcessId id={isNew ? processes.create : processes.update} />
            </span>
            {/* In a record frame its header carries «Descartar cambios» (owner 2026-11-05). */}
            {dirty && !isNew && !bridge?.registered && (
              <button type="button" className="erp-btn" onClick={() => setDraft(initial)} disabled={flow.saving}>
                {tf("discard")}
              </button>
            )}
            {!bridge?.registered && (
              <button type="button" className="erp-btn erp-btn--primary" aria-keyshortcuts={SAVE_SHORTCUTS} onClick={submit} disabled={missing || flow.saving || flow.stepUp || (!dirty && !isNew)}>
                {isNew ? tf("create") : tc("save")}
              </button>
            )}
          </div>
        </div>
      )}
    </RecordForm>
  );
}

/**
 * The input key that names the variant of a stock document's create (see `send`): `adjustment` for a Movimiento that is an ajuste. The
 * app's action picks the process from the entity and this variant (an allowlist keyed by entity, plan 2B Task 14b); the client never names
 * a process.
 */
export const STOCK_VARIANT_KEY = "__variant";

export interface StockDocumentFormProps {
  kind: Exclude<StockFormKind, StockMasterKind>;
  /** Today in the company's time zone (the default date). */
  today: string;
  warehouses: readonly CodeOption[];
  locations: readonly LocationOption[];
  product: LookupSource;
  /** A landed cost: the receipts it can be allocated to, the suppliers it can be owed to, and the cost centers of its cost of sales part. */
  receipt?: LookupSource;
  party?: LookupSource;
  costCenter?: LookupSource | null;
  /** How inventory tracks each tracked product, by id (Task 28.2): its lines ask for the lot or the serials. Untracked products are absent. */
  tracking?: Readonly<Record<string, "lot" | "serial">>;
  /** A copy ("Duplicar") of a stored document: its header. */
  initial?: Readonly<Record<string, unknown>> | null;
  readOnly?: boolean;
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  onSaved?: (id: string, created: boolean) => void;
}

/** A new document's draft from a copy: its header fields, its kind (a receipt or an issue) and one empty line. */
function draftFrom(kind: StockDocumentFormProps["kind"], today: string, warehouses: readonly CodeOption[], copy: Readonly<Record<string, unknown>> | null | undefined): StockDraft {
  const base = stockDraft(today, warehouses);
  if (!copy) return base;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const copiedKind = s(copy.kind);
  return {
    ...base,
    ...(kind === "movement" && (FORM_MOVEMENT_KINDS as readonly string[]).includes(copiedKind) ? { kind: copiedKind as StockDraft["kind"] } : {}),
    warehouseId: s(copy.warehouse_id) || s(copy.from_warehouse_id) || base.warehouseId,
    toWarehouseId: s(copy.to_warehouse_id),
    reference: s(copy.reference),
    description: s(copy.description),
  };
}

export function StockDocumentForm({ kind, today, warehouses, locations, product, receipt, party, costCenter, tracking = {}, initial: copy, readOnly = false, save, requestStepUp, onSaved }: StockDocumentFormProps) {
  const ns = kind === "landed_cost" ? "costing.form" : "inventory.form";
  const t = useTranslations(ns);
  const ti = useTranslations("inventory.form");
  const tv = useTranslations("inventory.values");
  const tcv = useTranslations("costing.values");
  const tf = useTranslations("common.forms");
  const errorText = useErrorText();
  const bridge = useRecordBridge();
  const [initial] = useState(() => draftFrom(kind, today, warehouses, copy));
  const [draft, setDraft] = useState<StockDraft>(initial);
  // One key per form: a retry of the same submit (a double click, a lost answer) answers the first allocation (Task 9 note).
  const [idempotencyKey] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random()}`));
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, true));
  const fieldKeys = ["date", "warehouseId", "fromWarehouseId", "toWarehouseId", "reference", "description", "reason", "movementId", "amount", "basis", "offsetRole", "partyId", "costCenterId"];
  const failed = failureMessages(flow.failure, fieldKeys, errorText);
  const missing = stockMissing(kind, draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  // An ajuste and an entrada are both Movimientos: the input says which (`__variant`, which the app's action takes off and maps to its
  // process by entity), and a step-up retry sends the very input the first try did.
  const variant = kind === "movement" && draft.kind === "adjustment" ? { [STOCK_VARIANT_KEY]: "adjustment" } : {};
  const send = () => flow.submit({ ...stockInput(kind, draft, kind === "landed_cost" ? idempotencyKey : undefined), ...variant });
  const submit = () => void send();
  const set = <K extends keyof StockDraft>(key: K) => (value: StockDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setLine = (key: string, patch: Partial<StockLine>) => setDraft((d) => {
    const lines = d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l));
    // A product chosen on the last line opens the next one.
    const last = lines.at(-1);
    return { ...d, lines: last && last.productId !== "" ? [...lines, emptyLine()] : lines };
  });
  const removeLine = (key: string) => setDraft((d) => ({ ...d, lines: d.lines.length > 1 ? d.lines.filter((l) => l.key !== key) : [emptyLine()] }));
  const productFetcher = gridFetcher("core.product");
  const locationsOf = (warehouseId: string) => locations.filter((l) => l.warehouseId === warehouseId);
  const movementKind = kind === "movement" ? draft.kind : null;

  const header = (() => {
    if (kind === "landed_cost") {
      return (
        <div className="erp-form2">
          <Field label={`${t("receipt")} *`} hint={t("receipt_hint")} error={failed.field("movementId")} className="erp-span3">
            {(id) => (
              <EntityLookup
                id={id}
                aria-label={t("receipt")}
                entityLabel={receipt?.entityLabel ?? ""}
                fetcher={gridFetcher("inventory.movement")}
                fields={receipt?.fields ?? []}
                baseFilters={[{ field: "kind", op: "eq", value: "receipt" }, { field: "status", op: "eq", value: "saved" }]}
                disabled={readOnly}
                value={draft.movementId ? { id: draft.movementId, label: draft.movementLabel } : null}
                href={receipt?.linkable && draft.movementId ? recordHref("inventory.movement", draft.movementId) : null}
                describe={(row: GridRow) => ({ label: String(row.number ?? row.id), sub: [row.date, row.reference].filter(Boolean).join(" · ") })}
                onPick={(row) => setDraft((d) => ({ ...d, movementId: row?.id ?? "", movementLabel: row ? String(row.number ?? row.id) : "" }))}
              />
            )}
          </Field>
          <TextField label={`${t("amount")} *`} value={draft.amount} inputMode="decimal" disabled={readOnly} error={failed.field("amount")} onChange={set("amount")} />
          <SelectField label={t("basis")} value={draft.basis} options={FORM_LANDED_BASES.map((b) => ({ code: b, name: tcv(`landed_basis.${b}`) }))} showCode={false} disabled={readOnly} error={failed.field("basis")} onChange={set("basis")} />
          <SelectField label={t("offset_role")} value={draft.offsetRole} options={FORM_OFFSET_ROLES.map((r) => ({ code: r, name: tcv(`offset_role.${r}`) }))} showCode={false} disabled={readOnly} error={failed.field("offsetRole")} onChange={set("offsetRole")} />
          <Field label={`${t("party")}${OWED_ROLES.includes(draft.offsetRole) ? " *" : ""}`} hint={t("party_hint")} error={failed.field("partyId")} className="erp-span3">
            {(id) => (
              <EntityLookup
                id={id}
                aria-label={t("party")}
                entityLabel={party?.entityLabel ?? ""}
                fetcher={gridFetcher("core.party")}
                fields={party?.fields ?? []}
                baseFilters={[{ field: "kind", op: "eq", value: "supplier" }]}
                disabled={readOnly}
                value={draft.partyId ? { id: draft.partyId, label: draft.partyLabel } : null}
                href={party?.linkable && draft.partyId ? recordHref("core.party", draft.partyId) : null}
                describe={(row: GridRow) => ({ label: String(row.legal_name ?? row.id), sub: String(row.document_number ?? "") })}
                onPick={(row) => setDraft((d) => ({ ...d, partyId: row?.id ?? "", partyLabel: row ? String(row.legal_name ?? row.id) : "" }))}
              />
            )}
          </Field>
          {costCenter && (
            <Field label={t("cost_center")} hint={t("cost_center_hint")} error={failed.field("costCenterId")} className="erp-span3">
              {(id) => (
                <EntityLookup
                  id={id}
                  aria-label={t("cost_center")}
                  entityLabel={costCenter.entityLabel}
                  fetcher={gridFetcher("accounting.cost_center")}
                  fields={costCenter.fields}
                  disabled={readOnly}
                  value={draft.costCenterId ? { id: draft.costCenterId, label: draft.costCenterLabel } : null}
                  href={null}
                  describe={(row: GridRow) => ({ label: [row.code, row.name].filter(Boolean).join(" · ") || String(row.id), sub: "" })}
                  onPick={(row) => setDraft((d) => ({ ...d, costCenterId: row?.id ?? "", costCenterLabel: row ? [row.code, row.name].filter(Boolean).join(" · ") : "" }))}
                />
              )}
            </Field>
          )}
          <DateField label={t("date")} value={draft.date} disabled={readOnly} error={failed.field("date")} onChange={set("date")} />
          <TextField label={t("reference")} value={draft.reference} maxLength={100} disabled={readOnly} error={failed.field("reference")} onChange={set("reference")} />
          <TextField label={t("description")} value={draft.description} maxLength={500} disabled={readOnly} error={failed.field("description")} onChange={set("description")} className="erp-span3" />
        </div>
      );
    }
    return (
      <div className="erp-form2">
        {kind === "movement" && (
          <SelectField label={`${t("kind")} *`} value={draft.kind} options={FORM_MOVEMENT_KINDS.map((k) => ({ code: k, name: tv(`movement_kind.${k}`) }))} showCode={false} disabled={readOnly} onChange={(v) => set("kind")(v as StockDraft["kind"])} />
        )}
        <DateField label={`${t("date")} *`} value={draft.date} disabled={readOnly} error={failed.field("date")} onChange={set("date")} />
        <SelectField
          label={`${kind === "transfer" ? t("from_warehouse") : t("warehouse")} *`}
          value={draft.warehouseId}
          options={warehouses}
          showCode={false}
          empty="—"
          disabled={readOnly}
          error={failed.field(kind === "transfer" ? "fromWarehouseId" : "warehouseId")}
          onChange={(v) => setDraft((d) => ({ ...d, warehouseId: v, lines: d.lines.map((l) => ({ ...l, locationId: "" })) }))}
        />
        {kind === "transfer" && (
          <SelectField
            label={`${t("to_warehouse")} *`}
            value={draft.toWarehouseId}
            options={warehouses.filter((w) => w.code !== draft.warehouseId)}
            showCode={false}
            empty="—"
            disabled={readOnly}
            error={failed.field("toWarehouseId")}
            onChange={(v) => setDraft((d) => ({ ...d, toWarehouseId: v, lines: d.lines.map((l) => ({ ...l, toLocationId: "" })) }))}
          />
        )}
        {kind !== "count" && <TextField label={t("reference")} value={draft.reference} maxLength={100} disabled={readOnly} error={failed.field("reference")} onChange={set("reference")} />}
        {movementKind === "adjustment" ? (
          <TextField label={`${t("reason")} *`} hint={t("reason_hint")} value={draft.reason} maxLength={500} disabled={readOnly} error={failed.field("reason")} onChange={set("reason")} className="erp-span3" />
        ) : (
          <TextField label={t("description")} value={draft.description} maxLength={500} disabled={readOnly} error={failed.field("description")} onChange={set("description")} className="erp-span3" />
        )}
      </div>
    );
  })();

  const lineLocations = locationsOf(draft.warehouseId);
  const destLocations = locationsOf(draft.toWarehouseId);
  const showCost = movementKind === "receipt";
  const showQty = kind !== "count";
  // Lots and serials (Task 28.2): the column shows only when a line's product is tracked; a conteo lists its lots and serials itself.
  const showTracking = kind !== "count" && draft.lines.some((l) => l.tracking !== "none");
  const inboundLine = (l: StockLine) => movementKind === "receipt" || (movementKind === "adjustment" && parseQty(l.qty) > 0);
  const lines =
    kind === "landed_cost" ? null : (
      <Section title={ti("lines")}>
        <div className="erp-lines__scroll">
          <table className="erp-lines__table" aria-label={ti("lines")}>
            <thead>
              <tr>
                <th scope="col" className="erp-lines__no">
                  #
                </th>
                <th scope="col">{ti("product")}</th>
                <th scope="col">{kind === "transfer" ? ti("from_location") : ti("location")}</th>
                {kind === "transfer" && <th scope="col">{ti("to_location")}</th>}
                {showQty && (
                  <th scope="col" className="erp-num">
                    {movementKind === "adjustment" ? ti("qty_signed") : ti("qty")}
                  </th>
                )}
                {showCost && (
                  <th scope="col" className="erp-num">
                    {ti("unit_cost")}
                  </th>
                )}
                {showTracking && <th scope="col">{ti("lot_serials")}</th>}
                <th scope="col">
                  <span className="sr-only">{ti("remove_line")}</span>
                </th>
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
                        aria-label={ti("product_line", { n })}
                        entityLabel={product.entityLabel}
                        fetcher={productFetcher}
                        fields={product.fields}
                        baseFilters={[{ field: "kind", op: "eq", value: "good" }, { field: "track_stock", op: "eq", value: true }]}
                        disabled={readOnly}
                        value={l.productId ? { id: l.productId, label: l.productLabel } : null}
                        href={product.linkable && l.productId ? recordHref("core.product", l.productId) : null}
                        describe={(row: GridRow) => ({ label: `${String(row.sku ?? "")} · ${String(row.description ?? "")}`, sub: String(row.uom_code ?? "") })}
                        onPick={(row) => setLine(l.key, {
                          productId: row?.id ?? "", productLabel: row ? `${String(row.sku ?? "")} · ${String(row.description ?? "")}` : "",
                          tracking: (row && tracking[row.id]) || "none", lotCode: "", expiresOn: "", serialNos: "",
                        })}
                      />
                    </td>
                    <td>
                      <select aria-label={ti("location_line", { n })} value={l.locationId} disabled={readOnly || lineLocations.length === 0} onChange={(e) => setLine(l.key, { locationId: e.target.value })}>
                        <option value="">{ti("no_location")}</option>
                        {lineLocations.map((o) => (
                          <option key={o.code} value={o.code}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    {kind === "transfer" && (
                      <td>
                        <select aria-label={ti("to_location_line", { n })} value={l.toLocationId} disabled={readOnly || destLocations.length === 0} onChange={(e) => setLine(l.key, { toLocationId: e.target.value })}>
                          <option value="">{ti("no_location")}</option>
                          {destLocations.map((o) => (
                            <option key={o.code} value={o.code}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    )}
                    {showQty && (
                      <td className="erp-num">
                        <input aria-label={ti("qty_line", { n })} className="erp-num erp-mono" inputMode="decimal" value={l.qty} disabled={readOnly} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                      </td>
                    )}
                    {showCost && (
                      <td className="erp-num">
                        <input aria-label={ti("unit_cost_line", { n })} className="erp-num erp-mono" inputMode="decimal" value={l.unitCost} disabled={readOnly} onChange={(e) => setLine(l.key, { unitCost: e.target.value })} />
                      </td>
                    )}
                    {showTracking && (
                      <td>
                        {l.tracking === "lot" && (
                          <span className="erp-row">
                            <input aria-label={ti("lot_line", { n })} placeholder={ti("lot_code")} className="erp-mono" maxLength={60} value={l.lotCode} disabled={readOnly} onChange={(e) => setLine(l.key, { lotCode: e.target.value })} />
                            {inboundLine(l) && (
                              <input aria-label={ti("expires_line", { n })} title={ti("expires_hint")} type="date" value={l.expiresOn} disabled={readOnly} onChange={(e) => setLine(l.key, { expiresOn: e.target.value })} />
                            )}
                          </span>
                        )}
                        {l.tracking === "serial" && (
                          <input aria-label={ti("serials_line", { n })} placeholder={ti("serials_hint")} className="erp-mono" value={l.serialNos} disabled={readOnly} onChange={(e) => setLine(l.key, { serialNos: e.target.value })} />
                        )}
                      </td>
                    )}
                    <td>
                      {l.productId !== "" && !readOnly && (
                        <button type="button" className="erp-btn erp-btn--ghost" aria-label={ti("remove_line_n", { n })} onClick={() => removeLine(l.key)}>
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
        {movementKind === "adjustment" && <p className="erp-small erp-muted">{ti("adjustment_hint")}</p>}
      </Section>
    );

  const sectionTitle = kind === "movement" ? t(`section.movement_${draft.kind}`) : t(`section.${kind}`);
  return (
    <RecordForm canSave={!readOnly && missing.length === 0 && !flow.saving && !flow.stepUp} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure}>
      <Section title={sectionTitle}>{header}</Section>
      {lines}
      {failed.panel.length > 0 && (
        <div className="erp-dian erp-dian--bad" role="alert" tabIndex={-1} data-error-summary="">
          <b>{failed.panel.join(" · ")}</b>
        </div>
      )}
      {!readOnly && (
        <div className="erp-form__actions">
          {flow.stepUp && <StepUpPrompt onConfirm={(code) => void flow.confirmStepUp(code)} onCancel={flow.cancelStepUp} error={flow.stepUpError} busy={flow.saving} />}
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {flow.saving ? tf("saving") : missing.length > 0 ? `${ti("missing")}: ${missing.map((m) => ti(`missing_field.${m}`)).join(", ")}` : ""} <kbd className="erp-mono">{tf("save_hint")}</kbd> ·{" "}
              <ProcessId id={createProcess(kind, draft)} />
            </span>
            {!bridge?.registered && (
              <button type="button" className="erp-btn erp-btn--primary" aria-keyshortcuts={SAVE_SHORTCUTS} onClick={submit} disabled={missing.length > 0 || flow.saving || flow.stepUp}>
                {tf("create")}
              </button>
            )}
          </div>
        </div>
      )}
    </RecordForm>
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
