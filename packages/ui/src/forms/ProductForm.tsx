"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { FieldMode, GridColumn, GridFetcher, GridRow, GridStateInput } from "../grid/types";
import { EntityLookup } from "../lookup/EntityLookup";
import { MoneyInput } from "../money/MoneyInput";
import { recordHref } from "../record/record-model";
import { ComputedField } from "./computed-field";
import { Checks, CodeComboboxField, RecordForm, DianPanel, failureMessages, Field, FormActions, InvoicePanel, MaskedField, Section, SelectField, TextField, useErrorText } from "./form-parts";
import {
  margin,
  productBlocked,
  productDraft,
  productInput,
  setProductField,
  taxesOverridden,
  toggleOtherTax,
  withCategory,
  withCategoryTaxes,
  type CategoryOption,
  type ProductDraft,
  type ProductTables,
} from "./product-form-model";
import { storedPending } from "./party-form-model";
import type { RequestStepUp, SaveRecord } from "./save-model";
import { useSaveFlow } from "./use-save";

type Filter = NonNullable<GridStateInput["filters"]>[number];

/** Input fields the form shows a process message under (the rest go to the DIAN panel). */
const PRODUCT_FIELDS = [
  "sku",
  "description",
  "kind",
  "categoryId",
  "idScheme",
  "standardCode",
  "brand",
  "model",
  "supplierId",
  "uomCode",
  "ivaRate",
  "incRate",
  "listPrice",
  "referencePriceType",
  "referencePrice",
  "standardCost",
  "minStock",
];

export interface ProductFormProps {
  /** The stored product as `core.product.consult` returns it, or null for a new one. */
  record: (Record<string, unknown> & { id: string }) | null;
  tables: ProductTables;
  /** The company's categories (active ones are offered; the product's own is always listed). */
  categories: readonly CategoryOption[];
  modes: Readonly<Record<string, FieldMode>>;
  readOnly?: boolean;
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  /** A new record started from a copy ("Duplicar", rule 37): the copy's values by field name, as a consult row has them. Ignored for a stored record. */
  initial?: Readonly<Record<string, unknown>> | null;
  onSaved?: (id: string, created: boolean) => void;
  /** The supplier lookup: parties of kind supplier through the grid route. */
  supplier: {
    fetcher: GridFetcher;
    fields: readonly GridColumn[];
    entityLabel: string;
    /** How the current supplier reads, when there is one. */
    label: string | null;
    /** The viewer may open a party's page: the chosen supplier links to it (rule 21). */
    linkable?: boolean;
    baseFilters?: Filter[];
  };
}

/**
 * The Datos tab of a product (design §5.8b, §5.18, prototype `renderProductForm`): identification with the category
 * and the supplier lookup, unit and taxes inherited from the category (or changed, with the reset), price and cost
 * with the free-sample reference price, inventory, then the DIAN and invoice-ready panels. Saves through
 * `core.product.create` / `core.product.update`.
 */
export function ProductForm({ record, initial: copy, tables, categories, modes, readOnly = false, save, requestStepUp, onSaved, supplier }: ProductFormProps) {
  const t = useTranslations("common.product_form");
  const tf = useTranslations("common.forms");
  const errorText = useErrorText();
  const isNew = record === null;
  const recordKey = record ? `${record.id}:${String(record.updated_at ?? "")}` : "new";
  const [seen, setSeen] = useState(recordKey);
  const [initial, setInitial] = useState(() => productDraft(record ?? copy ?? null));
  const [draft, setDraft] = useState(initial);
  const [supplierLabel, setSupplierLabel] = useState(supplier.label);
  if (seen !== recordKey) {
    const next = productDraft(record ?? copy ?? null);
    setSeen(recordKey);
    setInitial(next);
    setDraft(next);
    setSupplierLabel(supplier.label);
  }
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, isNew));

  const set =
    <K extends keyof ProductDraft>(key: K) =>
    (value: ProductDraft[K]) =>
      setDraft((d) => setProductField(d, key, value));
  const mode = (field: string): FieldMode => modes[field] ?? "visible";
  const dis = readOnly;
  const L = tables.limits;
  const scheme = tables.idSchemes.find((s) => s.code === draft.idScheme);
  const category = categories.find((c) => c.id === draft.categoryId) ?? null;
  const offered = categories.filter((c) => c.active || c.id === draft.categoryId);
  const overridden = category ? taxesOverridden(draft, category) : false;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const failed = failureMessages(flow.failure, PRODUCT_FIELDS, errorText);
  const fe = failed.field;
  const costMode = mode("standard_cost");
  const pct = costMode === "visible" ? margin(draft) : null;
  const ivaNote = draft.ivaRate === "EXC" ? t("iva_exc") : draft.ivaRate === "0" ? t("iva_zero") : draft.ivaRate ? t("iva_rate", { rate: draft.ivaRate }) : "";

  const send = () => flow.submit({ ...(record ? { id: record.id } : {}), ...productInput(draft, { standardCostVisible: costMode === "visible" }) });
  const submit = () => void send();

  return (
    <RecordForm canSave={!readOnly && !productBlocked(draft) && !flow.saving && !flow.stepUp && (dirty || isNew)} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure} {...(isNew ? {} : { onDiscard: () => setDraft(initial) })}>
      {readOnly && <div className="erp-dian erp-dian--info">{tf("read_only")}</div>}
      <Section title={t("identification")}>
        <div className="erp-form3">
          <TextField label={t("sku")} hint={t("sku_hint", { count: L.sku })} value={draft.sku} maxLength={L.sku} mono disabled={dis} error={fe("sku")} onChange={set("sku")} />
          <TextField className="erp-span2" label={t("description")} hint={tf("max", { count: L.description })} value={draft.description} maxLength={L.description} disabled={dis} error={fe("description")} onChange={set("description")} />
          <SelectField
            label={t("kind")}
            error={fe("kind")}
            value={draft.kind}
            showCode={false}
            disabled={dis}
            options={[
              { code: "good", name: t("kind_good") },
              { code: "service", name: t("kind_service") },
            ]}
            onChange={(v) => set("kind")(v as ProductDraft["kind"])}
          />
          <CodeComboboxField
            label={t("category")}
            hint={t("category_hint")}
            error={fe("categoryId")}
            value={draft.categoryId}
            showCode={false}
            empty="—"
            disabled={dis}
            options={offered.map((c) => ({
              code: c.id,
              name: [c.name, [t("iva_short", { rate: c.ivaRate }), c.incRate && t("inc_short", { rate: c.incRate }), c.otherTaxes.join("/")].filter(Boolean).join(" + ")].join(" · "),
            }))}
            onChange={(id) => setDraft((d) => withCategory(d, categories.find((c) => c.id === id) ?? null, isNew))}
          />
          <SelectField label={t("id_scheme")} value={draft.idScheme} disabled={dis} options={tables.idSchemes} error={fe("idScheme")} onChange={set("idScheme")} />
          {scheme?.kind === "own" ? (
            <ComputedField label={t("standard_code")} value={draft.sku} copyLabel={t("standard_code")} title={t("standard_code_own")} mono />
          ) : (
            <TextField
              label={scheme?.standardCodeLabel ?? t("standard_code")}
              hint={scheme?.kind === "gtin" ? t("gtin_hint") : scheme ? t("digits_hint", { count: scheme.length }) : undefined}
              value={draft.standardCode}
              maxLength={scheme?.length || undefined}
              inputMode="numeric"
              mono
              disabled={dis}
              error={fe("standardCode")}
              onChange={set("standardCode")}
            />
          )}
          <TextField label={t("brand")} hint={tf("optional")} value={draft.brand} maxLength={L.brand} disabled={dis} error={fe("brand")} onChange={set("brand")} />
          <TextField label={t("model")} hint={tf("optional")} value={draft.model} maxLength={L.model} disabled={dis} error={fe("model")} onChange={set("model")} />
          <Field label={t("supplier")} hint={t("supplier_hint")} error={fe("supplierId")} className="erp-span3">
            {(id) => (
              <EntityLookup
                id={id}
                aria-label={t("supplier")}
                entityLabel={supplier.entityLabel}
                fetcher={supplier.fetcher}
                fields={supplier.fields}
                baseFilters={supplier.baseFilters}
                placeholder={t("supplier_placeholder")}
                disabled={dis}
                value={draft.supplierId ? { id: draft.supplierId, label: supplierLabel ?? draft.supplierId } : null}
                href={supplier.linkable && draft.supplierId ? recordHref("core.party", draft.supplierId) : null}
                describe={(row: GridRow) => ({ label: String(row.legal_name ?? row.id), sub: [row.document_number, row.trade_name].filter(Boolean).join(" · ") })}
                onPick={(row) => {
                  setSupplierLabel(row ? String(row.legal_name ?? row.id) : null);
                  setDraft((d) => ({ ...d, supplierId: row?.id ?? "" }));
                }}
              />
            )}
          </Field>
        </div>
      </Section>

      <Section
        title={t("taxes")}
        extra={
          category &&
          (overridden ? (
            <>
              <span className="erp-pill erp-pill--warn">{t("overridden", { category: category.name })}</span>{" "}
              {!dis && (
                <button type="button" className="erp-link" onClick={() => setDraft((d) => withCategoryTaxes(d, category))}>
                  {t("reset_taxes")}
                </button>
              )}
            </>
          ) : (
            <span className="erp-pill erp-pill--ok">{t("inherited", { category: category.name })}</span>
          ))
        }
      >
        <div className="erp-form3">
          <CodeComboboxField label={t("uom")} value={draft.uomCode} empty="—" disabled={dis} options={tables.uoms} error={fe("uomCode")} onChange={set("uomCode")} />
          <SelectField label={t("iva")} value={draft.ivaRate} empty="—" disabled={dis} options={tables.ivaRates} error={fe("ivaRate")} onChange={set("ivaRate")} />
          <SelectField label={t("inc")} value={draft.incRate} empty={tf("none")} disabled={dis} options={tables.incRates} error={fe("incRate")} onChange={set("incRate")} />
          <div className="erp-span2">
            <Checks label={t("other_taxes")} options={tables.otherTaxes} value={draft.otherTaxes} row disabled={dis} onToggle={(code, on) => setDraft((d) => toggleOtherTax(d, code, on))} />
          </div>
          <div className="erp-field">
            <span className="erp-field__label">{t("fiscal_summary")}</span>
            <div className="erp-rut">
              {[draft.ivaRate && t("iva_short", { rate: draft.ivaRate }), draft.incRate && t("inc_short", { rate: draft.incRate }), ...draft.otherTaxes].filter(Boolean).join(" + ") || "—"}
              <br />
              <span className="erp-muted">{ivaNote}</span>
            </div>
          </div>
        </div>
      </Section>

      <Section title={t("price")}>
        <div className="erp-form4">
          <Field label={t("list_price")} hint={t("list_price_hint")} error={fe("listPrice")}>
            {(id) => <MoneyInput id={id} value={draft.listPrice} disabled={dis} onChange={set("listPrice")} />}
          </Field>
          <Field label={t("free_sample")}>
            {(id) => (
              <label className="erp-check">
                <input id={id} type="checkbox" checked={draft.isFreeSample} disabled={dis} onChange={(e) => set("isFreeSample")(e.target.checked)} /> {t("free_sample_label")}
              </label>
            )}
          </Field>
          {draft.isFreeSample ? (
            <>
              <SelectField label={t("reference_price_type")} value={draft.referencePriceType} empty="—" disabled={dis} options={tables.priceTypes} error={fe("referencePriceType")} onChange={set("referencePriceType")} />
              <Field label={t("reference_price")} hint={t("reference_price_hint")} error={fe("referencePrice")}>
                {(id) => <MoneyInput id={id} value={draft.referencePrice} disabled={dis} onChange={set("referencePrice")} />}
              </Field>
            </>
          ) : (
            <>
              <div />
              <div />
            </>
          )}
          {costMode === "masked" ? (
            <MaskedField label={t("standard_cost")} />
          ) : costMode === "visible" ? (
            <Field label={t("standard_cost")} hint={t("standard_cost_hint")} error={fe("standardCost")}>
              {(id) => <MoneyInput id={id} value={draft.standardCost} disabled={dis} onChange={set("standardCost")} />}
            </Field>
          ) : null}
          <ComputedField label={t("margin")} value={pct === null ? "—" : `${pct} %`} copyText={pct === null ? "" : `${pct} %`} copyLabel={t("margin")} inputClassName="erp-num text-right" />
        </div>
      </Section>

      <Section title={t("inventory")}>
        <div className="erp-form4">
          <Field label={t("track_stock")}>
            {(id) => (
              <label className="erp-check">
                <input id={id} type="checkbox" checked={draft.trackStock} disabled={dis || draft.kind === "service"} onChange={(e) => set("trackStock")(e.target.checked)} />{" "}
                {draft.kind === "service" ? t("track_stock_service") : t("track_stock_label")}
              </label>
            )}
          </Field>
          {draft.trackStock && <TextField label={t("min_stock")} hint={t("min_stock_hint")} value={draft.minStock} inputMode="decimal" disabled={dis} error={fe("minStock")} onChange={set("minStock")} />}
        </div>
      </Section>

      <DianPanel errors={failed.panel} pending={storedPending(record)} />
      {record && <InvoicePanel record={record} />}
      <span className="erp-small erp-muted">{t("footnote")}</span>
      {!readOnly && (
        <FormActions
          flow={flow}
          isNew={isNew}
          dirty={dirty}
          blocked={productBlocked(draft)}
          pendingCount={storedPending(record)?.length ?? null}
          onSave={submit}
          onDiscard={() => setDraft(initial)}
          process={isNew ? "core.product.create" : "core.product.update"}
        />
      )}
    </RecordForm>
  );
}
