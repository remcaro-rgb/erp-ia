"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { EmailField } from "../fields/EmailField";
import { PhoneField } from "../fields/PhoneField";
import type { FieldMode } from "../grid/types";
import { formatMoney } from "../money/format";
import { MoneyInput } from "../money/MoneyInput";
import { Checks, RecordForm, DianPanel, Field, FieldError, failureMessages, FormActions, InvoicePanel, MaskedField, Section, SelectField, TextField, useErrorText, useFieldLabels } from "./form-parts";
import {
  checkDigitOf,
  composedName,
  documentProblem,
  documentTypesFor,
  includesCustomer,
  includesSupplier,
  partyBlocked,
  partyDraft,
  partyInput,
  setPartyField,
  storedPending,
  toggleResponsibility,
  type PartyDraft,
  type PartyTables,
} from "./party-form-model";
import type { RequestStepUp, SaveRecord } from "./save-model";
import { useSaveFlow } from "./use-save";

export interface PartyFormProps {
  /** The stored party as `core.party.consult` returns it (masked fields null), or null for a new one. */
  record: (Record<string, unknown> & { id: string }) | null;
  /** The country pack's code tables. */
  tables: PartyTables;
  /** Field modes of the caller (`credit_limit`, `balance`…); absent means visible. */
  modes: Readonly<Record<string, FieldMode>>;
  /** The caller may not run the update process: everything is read-only. */
  readOnly?: boolean;
  /** Runs `core.party.create` (new) or `core.party.update`. */
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  /** After a save: the record's id and whether it was created. */
  onSaved?: (id: string, created: boolean) => void;
}

/** Input fields the form shows a process message under (the rest go to the DIAN panel). */
const PARTY_FIELDS = [
  "kind",
  "personType",
  "documentType",
  "documentNumber",
  "legalName",
  "firstSurname",
  "secondSurname",
  "firstName",
  "otherNames",
  "tradeName",
  "taxScheme",
  "ciiu",
  "countryCode",
  "departmentCode",
  "municipalityCode",
  "addressLine",
  "postalCode",
  "invoiceEmail",
  "supplierEmail",
  "phoneCc",
  "phone",
  "contactName",
  "creditLimit",
];

const rutKey = (code: string) => `rut_${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

/**
 * The Datos tab of a party (design §5.8a, §5.18, prototype `renderPartyForm`): identification with the check digit
 * computed live, name (legal name or surnames and names), fiscal responsibility with the RUT summary, location with
 * DANE codes, commercial data, the e-mails each relation needs and the phone, then the DIAN and invoice-ready panels.
 * Saves through `core.party.create` / `core.party.update`; the process's messages are the validation messages.
 */
export function PartyForm({ record, tables, modes, readOnly = false, save, requestStepUp, onSaved }: PartyFormProps) {
  const t = useTranslations("common.party_form");
  const tf = useTranslations("common.forms");
  const errorText = useErrorText();
  const fieldLabels = useFieldLabels();
  const recordKey = record ? `${record.id}:${String(record.updated_at ?? "")}` : "new";
  const [seen, setSeen] = useState(recordKey);
  const [initial, setInitial] = useState(() => partyDraft(record, tables));
  const [draft, setDraft] = useState(initial);
  if (seen !== recordKey) {
    // The page reloaded the record after a save: start over from it.
    const next = partyDraft(record, tables);
    setSeen(recordKey);
    setInitial(next);
    setDraft(next);
  }
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, record === null));

  const set = (key: Parameters<typeof setPartyField>[1]) => (value: string) => setDraft((d) => setPartyField(d, key, value, tables));
  const mode = (field: string): FieldMode => modes[field] ?? "visible";
  const dis = readOnly;
  const home = draft.countryCode === tables.homeCountry;
  const natural = draft.personType !== "1";
  const docDef = tables.documentTypes.find((d) => d.code === draft.documentType);
  const dv = checkDigitOf(draft, tables);
  const docProblem = documentProblem(draft, tables);
  const blocked = partyBlocked(draft, tables);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const failed = failureMessages(flow.failure, PARTY_FIELDS, errorText);
  const fe = failed.field;
  const docTypes = documentTypesFor(tables, draft.personType, draft.countryCode);
  const municipalities = tables.municipalities.filter((m) => !draft.departmentCode || m.departmentCode === draft.departmentCode);
  const L = tables.limits;

  const submit = () => void flow.submit({ ...(record ? { id: record.id } : {}), ...partyInput(draft, { creditLimitVisible: mode("credit_limit") === "visible" }) });

  return (
    <RecordForm canSave={!readOnly && !blocked && !flow.saving && !flow.stepUp && (dirty || record === null)} onSave={submit} failure={flow.failure}>
      {readOnly && <div className="erp-dian erp-dian--info">{tf("read_only")}</div>}
      <Section title={t("identification")}>
        <div className="erp-form3">
          <SelectField
            label={t("person_type")}
            hint="AdditionalAccountID"
            value={draft.personType}
            disabled={dis}
            options={[
              { code: "1", name: t("person_1") },
              { code: "2", name: t("person_2") },
            ]}
            error={fe("personType")}
            onChange={set("personType")}
          />
          <SelectField label={t("document_type")} hint="schemeName" value={draft.documentType} disabled={dis} options={docTypes} error={fe("documentType")} onChange={set("documentType")} />
          <div className="erp-row erp-row--top">
            <TextField
              className="erp-grow"
              label={t("number")}
              hint={docDef ? `${docDef.charset === "num" ? t("digits_only") : t("alnum")} · ${tf("max", { count: docDef.maxLength })}` : undefined}
              value={draft.documentNumber}
              disabled={dis}
              maxLength={docDef?.maxLength ?? 20}
              inputMode={docDef?.charset === "num" ? "numeric" : "text"}
              mono
              error={docProblem ? (docProblem.key === "max" ? t("doc_max", { count: docProblem.count }) : docProblem.key === "digits" ? t("doc_digits") : t("doc_alnum")) : fe("documentNumber")}
              onChange={(v) => set("documentNumber")(v.trim())}
            />
            {tables.checkDigitTypes.includes(draft.documentType) && (
              <Field label={t("dv")} className="erp-field--dv">
                {(id) => <input id={id} className="erp-mono" disabled value={dv ?? ""} title={t("dv_title")} />}
              </Field>
            )}
          </div>
        </div>
      </Section>

      <Section title={t("name")}>
        {natural ? (
          <>
            <div className="erp-form4">
              <TextField label={t("first_surname")} hint={tf("max", { count: L.namePart })} value={draft.firstSurname} maxLength={L.namePart} disabled={dis} error={fe("firstSurname")} onChange={set("firstSurname")} />
              <TextField label={t("second_surname")} value={draft.secondSurname} maxLength={L.namePart} disabled={dis} error={fe("secondSurname")} onChange={set("secondSurname")} />
              <TextField label={t("first_name")} value={draft.firstName} maxLength={L.namePart} disabled={dis} error={fe("firstName")} onChange={set("firstName")} />
              <TextField label={t("other_names")} value={draft.otherNames} maxLength={L.namePart} disabled={dis} error={fe("otherNames")} onChange={set("otherNames")} />
            </div>
            <div className="erp-form2">
              <TextField label={t("trade_name_natural")} hint={tf("optional")} value={draft.tradeName} maxLength={L.legalName} disabled={dis} error={fe("tradeName")} onChange={set("tradeName")} />
              <Field label={t("document_name")}>{(id) => <input id={id} disabled value={composedName(draft)} title={t("document_name_title")} />}</Field>
            </div>
          </>
        ) : (
          <div className="erp-form2">
            <TextField label={t("legal_name")} hint={t("legal_name_hint", { count: L.legalName })} value={draft.legalName} maxLength={L.legalName} disabled={dis} error={fe("legalName")} onChange={set("legalName")} />
            <TextField label={t("trade_name")} hint={tf("optional")} value={draft.tradeName} maxLength={L.legalName} disabled={dis} error={fe("tradeName")} onChange={set("tradeName")} />
          </div>
        )}
      </Section>

      <Section title={t("tax")}>
        <div className="erp-form3">
          <Checks
            label={t("responsibilities")}
            hint={t("responsibilities_hint")}
            options={tables.responsibilities}
            value={draft.taxResponsibilities}
            disabled={dis}
            onToggle={(code, on) => setDraft((d) => toggleResponsibility(d, code, on, tables.exclusiveResponsibility))}
          />
          <div className="erp-stack">
            <SelectField label={t("tax_scheme")} hint="TaxScheme" value={draft.taxScheme} disabled={dis} options={tables.taxSchemes} error={fe("taxScheme")} onChange={set("taxScheme")} />
            <TextField label={t("ciiu")} hint={t("ciiu_hint")} value={draft.ciiu} maxLength={4} inputMode="numeric" mono disabled={dis} error={fe("ciiu")} onChange={set("ciiu")} />
          </div>
          <div className="erp-field">
            <span className="erp-field__label">{t("rut")}</span>
            <div className="erp-rut">
              {natural ? t("rut_natural") : t("rut_juridica")} · {docDef?.name ?? draft.documentType} {draft.documentNumber}
              {dv !== null && `-${dv}`}
              <br />
              {draft.taxResponsibilities.map((r) => (
                <span key={r} className="erp-pill erp-pill--info">
                  {r}
                </span>
              ))}{" "}
              <span className="erp-pill erp-pill--gray">{tables.taxSchemes.find((s) => s.code === draft.taxScheme)?.name ?? draft.taxScheme}</span>
              <br />
              <span className="erp-muted">
                {draft.taxResponsibilities
                  .filter((r) => t.has(rutKey(r)))
                  .map((r) => t(rutKey(r)))
                  .join(" ")}
              </span>
            </div>
          </div>
        </div>
      </Section>

      <Section title={t("location")}>
        <div className="erp-form4">
          <SelectField label={t("country")} hint="ISO 3166-1" value={draft.countryCode} disabled={dis} options={tables.countries} error={fe("countryCode")} onChange={set("countryCode")} />
          {home ? (
            <>
              <SelectField label={t("department")} hint="DANE" value={draft.departmentCode} disabled={dis} options={tables.departments} empty="—" error={fe("departmentCode")} onChange={set("departmentCode")} />
              <SelectField label={t("municipality")} hint="DANE" value={draft.municipalityCode} disabled={dis} options={municipalities} empty="—" error={fe("municipalityCode")} onChange={set("municipalityCode")} />
              <TextField label={t("postal_code")} hint={t("postal_hint")} value={draft.postalCode} maxLength={6} inputMode="numeric" mono disabled={dis} error={fe("postalCode")} onChange={set("postalCode")} />
            </>
          ) : (
            <Field label={t("foreign_city")} className="erp-span3">
              {(id) => <input id={id} disabled value={t("foreign_city_value")} />}
            </Field>
          )}
        </div>
        <TextField label={t("address")} hint={t("address_hint", { count: L.address })} value={draft.addressLine} maxLength={L.address} disabled={dis} error={fe("addressLine")} onChange={set("addressLine")} />
      </Section>

      <Section title={t("commercial")}>
        <div className="erp-form4">
          <SelectField
            label={t("relation")}
            error={fe("kind")}
            value={draft.relation}
            disabled={dis}
            showCode={false}
            options={[
              { code: "customer", name: t("relation_customer") },
              { code: "supplier", name: t("relation_supplier") },
              { code: "both", name: t("relation_both") },
            ]}
            onChange={(v) => setDraft((d) => ({ ...d, relation: v as PartyDraft["relation"] }))}
          />
          {mode("credit_limit") === "masked" ? (
            <MaskedField label={t("credit_limit")} />
          ) : mode("credit_limit") === "visible" ? (
            <Field label={t("credit_limit")} error={fe("creditLimit")}>{(id) => <MoneyInput id={id} value={draft.creditLimit} disabled={dis} onChange={(v) => setDraft((d) => ({ ...d, creditLimit: v }))} />}</Field>
          ) : null}
          {mode("balance") === "masked" ? (
            <MaskedField label={t("balance")} />
          ) : mode("balance") === "visible" ? (
            <Field label={t("balance")}>{(id) => <input id={id} disabled className="erp-num text-right" value={formatMoney((record?.balance as string | number | null) ?? 0)} />}</Field>
          ) : null}
          <TextField label={t("contact_name")} hint={tf("optional")} value={draft.contactName} disabled={dis} error={fe("contactName")} onChange={set("contactName")} />
        </div>
      </Section>

      <Section title={t("emails")}>
        <div className="erp-form3">
          {includesCustomer(draft.relation) && (
            <div className="erp-field-wrap">
              <EmailField label={t("invoice_email")} hint={`${t("pill_customer")} · ${t("invoice_email_hint")}`} value={draft.invoiceEmail} required disabled={dis} announce={false} labels={fieldLabels} onChange={set("invoiceEmail")} />
              <FieldError message={fe("invoiceEmail")} />
            </div>
          )}
          {includesSupplier(draft.relation) && (
            <div className="erp-field-wrap">
              <EmailField label={t("supplier_email")} hint={`${t("pill_supplier")} · ${t("supplier_email_hint")}`} value={draft.supplierEmail} required disabled={dis} announce={false} labels={fieldLabels} onChange={set("supplierEmail")} />
              <FieldError message={fe("supplierEmail")} />
            </div>
          )}
          <PhoneField
            announce={false}
            label={t("phone")}
            hint={t("phone_hint")}
            cc={draft.phoneCc}
            number={draft.phone}
            disabled={dis}
            labels={fieldLabels}
            onChange={({ cc, number }) => setDraft((d) => ({ ...d, phoneCc: cc, phone: number }))}
          />
          <FieldError message={fe("phone") ?? fe("phoneCc")} />
        </div>
        <span className="erp-small erp-muted">{draft.relation === "both" ? t("both_emails") : t("more_contacts")}</span>
      </Section>

      <DianPanel errors={failed.panel} pending={storedPending(record)} party />
      {record && <InvoicePanel record={record} />}
      <span className="erp-small erp-muted">{t("footnote")}</span>
      {!readOnly && (
        <FormActions
          flow={flow}
          isNew={record === null}
          dirty={dirty}
          blocked={blocked}
          pendingCount={storedPending(record)?.length ?? null}
          onSave={submit}
          onDiscard={() => setDraft(initial)}
          process={record ? "core.party.update" : "core.party.create"}
        />
      )}
    </RecordForm>
  );
}
