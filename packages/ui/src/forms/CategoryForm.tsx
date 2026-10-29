"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { categoryDraft, categoryInput, incomeAccountProblem, nameMissing, type CategoryDraft } from "./category-form-model";
import { Checks, RecordForm, failureMessages, FormActions, Section, SelectField, TextField, useErrorText } from "./form-parts";
import type { ProductTables } from "./product-form-model";
import type { RequestStepUp, SaveRecord } from "./save-model";
import { useSaveFlow } from "./use-save";

/** Input fields the form shows a process message under (the rest go to the status panel). */
const CATEGORY_FIELDS = ["name", "status", "ivaRate", "incRate", "defaultUom", "incomeAccount"];

export interface CategoryFormProps {
  /** The stored category as `core.category.consult` returns it, or null for a new one. */
  record: (Record<string, unknown> & { id: string }) | null;
  tables: Pick<ProductTables, "ivaRates" | "incRates" | "otherTaxes" | "uoms">;
  /** Products that use the category (shown when editing). */
  productCount?: number;
  readOnly?: boolean;
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  onSaved?: (id: string, created: boolean) => void;
}

/**
 * The Datos tab of a product category (design §5.18, prototype `renderCategoryForm`): name and status, the default
 * taxes and unit new products inherit, the income account; editing it never rewrites the products that use it.
 */
export function CategoryForm({ record, tables, productCount = 0, readOnly = false, save, requestStepUp, onSaved }: CategoryFormProps) {
  const t = useTranslations("common.category_form");
  const tf = useTranslations("common.forms");
  const errorText = useErrorText();
  const isNew = record === null;
  const defaultIva = tables.ivaRates[0]?.code ?? "";
  const recordKey = record ? `${record.id}:${String(record.updated_at ?? "")}` : "new";
  const [seen, setSeen] = useState(recordKey);
  const [initial, setInitial] = useState(() => categoryDraft(record, defaultIva));
  const [draft, setDraft] = useState(initial);
  if (seen !== recordKey) {
    const next = categoryDraft(record, defaultIva);
    setSeen(recordKey);
    setInitial(next);
    setDraft(next);
  }
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, isNew));
  const set =
    <K extends keyof CategoryDraft>(key: K) =>
    (value: CategoryDraft[K]) =>
      setDraft((d) => ({ ...d, [key]: value }));
  const dis = readOnly;
  const accountBad = incomeAccountProblem(draft);
  const missing = nameMissing(draft);
  const failed = failureMessages(flow.failure, CATEGORY_FIELDS, errorText);
  const fe = failed.field;
  const problems = [...(accountBad ? [t("income_account_error")] : []), ...failed.panel];
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const submit = () => void flow.submit({ ...(record ? { id: record.id } : {}), ...categoryInput(draft) });

  return (
    <RecordForm canSave={!readOnly && !accountBad && !missing && !flow.saving && (dirty || isNew)} onSave={submit} failure={flow.failure}>
      {readOnly && <div className="erp-dian erp-dian--info">{tf("read_only")}</div>}
      <Section title={t("category")}>
        <div className="erp-form2">
          <TextField label={t("name")} value={draft.name} maxLength={100} disabled={dis} error={fe("name")} onChange={set("name")} />
          <SelectField
            label={t("status")}
            error={fe("status")}
            value={draft.status}
            showCode={false}
            disabled={dis}
            options={[
              { code: "active", name: t("active") },
              { code: "inactive", name: t("inactive") },
            ]}
            onChange={(v) => set("status")(v as CategoryDraft["status"])}
          />
        </div>
      </Section>
      <Section title={t("taxes")} extra={<span className="erp-hint">{t("taxes_hint")}</span>}>
        <div className="erp-form3">
          <SelectField label={t("iva")} value={draft.ivaRate} disabled={dis} options={tables.ivaRates} error={fe("ivaRate")} onChange={set("ivaRate")} />
          <SelectField label={t("inc")} value={draft.incRate} empty={tf("none")} disabled={dis} options={tables.incRates} error={fe("incRate")} onChange={set("incRate")} />
          <SelectField label={t("default_uom")} value={draft.defaultUom} empty="—" disabled={dis} options={tables.uoms} error={fe("defaultUom")} onChange={set("defaultUom")} />
          <div className="erp-span2">
            <Checks
              label={t("other_taxes")}
              options={tables.otherTaxes}
              value={draft.otherTaxes}
              row
              disabled={dis}
              onToggle={(code, on) => setDraft((d) => ({ ...d, otherTaxes: on ? [...d.otherTaxes.filter((c) => c !== code), code] : d.otherTaxes.filter((c) => c !== code) }))}
            />
          </div>
          <TextField
            label={t("income_account")}
            hint={t("income_account_hint")}
            value={draft.incomeAccount}
            maxLength={8}
            inputMode="numeric"
            mono
            disabled={dis}
            error={accountBad ? t("income_account_error") : fe("incomeAccount")}
            onChange={set("incomeAccount")}
          />
        </div>
      </Section>
      {!isNew && (
        <div className={productCount > 0 ? "erp-dian erp-dian--warn" : "erp-dian erp-dian--ok"}>
          <b>{t("products", { count: productCount })}</b> · {t("products_note")}
        </div>
      )}
      <div className={problems.length > 0 ? "erp-dian erp-dian--bad" : missing ? "erp-dian erp-dian--warn" : "erp-dian erp-dian--ok"} role={problems.length > 0 ? "alert" : undefined} tabIndex={problems.length > 0 ? -1 : undefined} data-error-summary={problems.length > 0 ? "" : undefined}>
        <b>{problems.length > 0 ? problems.join(" · ") : missing ? t("missing_name") : t("ready")}</b>
      </div>
      {!readOnly && (
        <FormActions
          flow={flow}
          isNew={isNew}
          dirty={dirty}
          blocked={accountBad || missing}
          pendingCount={0}
          onSave={submit}
          onDiscard={() => setDraft(initial)}
          process={isNew ? "core.category.create" : "core.category.update"}
        />
      )}
    </RecordForm>
  );
}
