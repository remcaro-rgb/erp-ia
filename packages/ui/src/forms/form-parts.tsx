"use client";

import { useId, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { FieldLabels } from "../fields/field-model";
import { invoiceBlockers } from "../lookup/lookup-model";
import { StepUpPrompt } from "./StepUpPrompt";
import type { CodeOption } from "./save-model";
import type { SaveFlow } from "./use-save";

// The building blocks of the record forms (prototype `.sec`, `.field`, `.form3`, `.dian`, `recStatus`). Labels come
// translated from the forms; these only lay them out.

export function Section({ title, extra, children }: { title: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="erp-sec">
      <h3>
        {title}
        {extra && <> {extra}</>}
      </h3>
      {children}
    </section>
  );
}

/** A labelled control; `children` receives the control's id. */
export function Field({ label, hint, error, className, children }: { label: ReactNode; hint?: ReactNode; error?: string | null; className?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={["erp-field", className].filter(Boolean).join(" ")}>
      <label htmlFor={id}>
        {label}
        {hint && <span className="erp-field__hint"> {hint}</span>}
      </label>
      {children(id)}
      {error && (
        <span role="alert" className="erp-field__error">
          {error}
        </span>
      )}
    </div>
  );
}

export interface SelectFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  value: string;
  options: readonly CodeOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** A first option with this text and an empty value. */
  empty?: string;
  /** Shows `code · name` (prototype `sel`). */
  showCode?: boolean;
  className?: string;
}

export function SelectField({ label, hint, error, value, options, onChange, disabled, empty, showCode = true, className }: SelectFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {(id) => (
        <select id={id} value={value} disabled={disabled} aria-invalid={error ? true : undefined} className={error ? "erp-input--bad" : undefined} onChange={(e) => onChange(e.target.value)}>
          {empty !== undefined && <option value="">{empty}</option>}
          {!options.some((o) => o.code === value) && value !== "" && <option value={value}>{value}</option>}
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {showCode ? `${o.code} · ${o.name}` : o.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export interface TextFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  maxLength?: number;
  inputMode?: "numeric" | "text" | "decimal";
  mono?: boolean;
  error?: string | null;
  className?: string;
}

export function TextField({ label, hint, value, onChange, disabled, maxLength, inputMode, mono, error, className }: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      {(id) => (
        <input
          id={id}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          inputMode={inputMode}
          aria-invalid={error ? true : undefined}
          className={[mono && "erp-mono", error && "erp-input--bad"].filter(Boolean).join(" ") || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** A set of codes as checkboxes (responsibilities, other taxes). */
export function Checks({ label, hint, options, value, onToggle, disabled, row }: { label: ReactNode; hint?: ReactNode; options: readonly CodeOption[]; value: readonly string[]; onToggle: (code: string, on: boolean) => void; disabled?: boolean; row?: boolean }) {
  return (
    <fieldset className="erp-field">
      <legend>
        {label}
        {hint && <span className="erp-field__hint"> {hint}</span>}
      </legend>
      <div className={row ? "erp-checks erp-checks--row" : "erp-checks"}>
        {options.map((o) => (
          <label key={o.code}>
            <input type="checkbox" checked={value.includes(o.code)} disabled={disabled} onChange={(e) => onToggle(o.code, e.target.checked)} />
            <span className="erp-mono">{o.code}</span> {o.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A field's message from the process, under a control that has no error slot of its own (e-mail, phone). */
export function FieldError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <span role="alert" className="erp-field__error">
      {message}
    </span>
  );
}

export interface FailureMessages {
  /** Messages for the DIAN panel: the pack's (no field) and those of fields the form does not show. */
  panel: string[];
  /** The process's message(s) about one input field, or null. */
  field: (key: string) => string | null;
}

/**
 * Where a refused save's messages go (rule: validation messages come from the process): a Zod issue under the field
 * its path names, when the form shows that field; everything else, and any other refusal, in the panel.
 */
export function failureMessages(failure: SaveFlow["failure"], fieldKeys: readonly string[], translateError: (code: string) => string): FailureMessages {
  if (!failure) return { panel: [], field: () => null };
  if (failure.code !== "invalid_input" || failure.details.length === 0) return { panel: [translateError(failure.code)], field: () => null };
  const byField = new Map<string, string[]>();
  const panel: string[] = [];
  for (const issue of failure.details) {
    const key = issue.path?.[0];
    if (key && fieldKeys.includes(key)) byField.set(key, [...(byField.get(key) ?? []), issue.message]);
    else panel.push(issue.path?.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message);
  }
  return { panel, field: (key) => byField.get(key)?.join(" · ") ?? null };
}

/** `errors.<code>` from the catalogue, `errors.unknown` for a code it does not know. */
export function useErrorText(): (code: string) => string {
  const te = useTranslations("errors");
  return (code) => (te.has(code) ? te(code) : te("unknown"));
}

/** A value the role may not see (masked) or edit: a disabled box. */
export function MaskedField({ label }: { label: ReactNode }) {
  const t = useTranslations();
  return (
    <Field label={label}>
      {(id) => <input id={id} disabled value="••••••" title={t("common.forms.masked")} />}
    </Field>
  );
}

/** The labels of the phone and e-mail fields, from the catalogue. */
export function useFieldLabels(): FieldLabels {
  const t = useTranslations("field.ui");
  return {
    countryCode: t("country_code"),
    validFormat: t("valid_format"),
    phoneHintCo: t("phone_hint_co"),
    phoneHintOther: t("phone_hint_other"),
    required: t("required"),
    verify: t("verify"),
    verifyTitle: t("verify_title"),
    queued: t("queued"),
    verified: (provider) => (provider ? t("verified_by", { provider }) : t("verified")),
    failed: t("failed"),
  };
}

export interface DianPanelProps {
  /** Errors that block the save: the client's checks and the process's `invalid_input` messages. */
  errors: readonly string[];
  /** Missing DIAN data of the stored record (`dian_missing`), or null before the first save. */
  pending: readonly string[] | null;
  /** Parties also report exógena. */
  party?: boolean;
}

/** The DIAN status panel (prototype `dianPanel`): errors that block, data still missing, or complete. */
export function DianPanel({ errors, pending, party }: DianPanelProps) {
  const t = useTranslations("common.forms");
  if (errors.length > 0) {
    return (
      <div className="erp-dian erp-dian--bad" role="alert">
        <b>{t("dian_errors", { count: errors.length })}</b>
        <ul>
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (pending === null) return <div className="erp-dian erp-dian--info">{t("dian_on_save")}</div>;
  if (pending.length > 0) {
    return (
      <div className="erp-dian erp-dian--warn">
        <b>{t(party ? "dian_missing_party" : "dian_missing", { count: pending.length })}</b>
        <ul>
          {pending.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="erp-dian erp-dian--ok">
      <b>{t("dian_ok")}</b>
    </div>
  );
}

/** Whether the stored record can go on an invoice (design §5.17) and why not. */
export function InvoicePanel({ record }: { record: Record<string, unknown> & { id: string } }) {
  const t = useTranslations();
  const blockers = invoiceBlockers(record);
  return (
    <div className={blockers.length === 0 ? "erp-dian erp-dian--ok" : "erp-dian erp-dian--bad"}>
      <b>{blockers.length === 0 ? t("common.forms.invoice_ok") : t("common.forms.invoice_no")}</b>
      {blockers.length > 0 && (
        <ul>
          {blockers.map((b) => (
            <li key={b.key}>
              {b.key === "dian" ? t("grid.lookup.reason_dian", { items: b.items.join(", ") }) : t(`grid.lookup.reason_${b.key}`)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface FormActionsProps {
  flow: SaveFlow;
  isNew: boolean;
  dirty: boolean;
  /** Client errors: the save stays disabled. */
  blocked: boolean;
  /** Missing DIAN data the stored record has. */
  pendingCount: number | null;
  onSave: () => void;
  onDiscard: () => void;
  process: string;
}

/** The form's footer (prototype `recStatus`): what the save will do, discard, save, and the step-up prompt when asked. */
export function FormActions({ flow, isNew, dirty, blocked, pendingCount, onSave, onDiscard, process }: FormActionsProps) {
  const t = useTranslations("common.forms");
  const common = useTranslations("common");
  const status = blocked || flow.failure ? t("fix_errors") : pendingCount === null ? t("dian_on_save") : pendingCount > 0 ? t("will_save_missing", { count: pendingCount }) : t("dian_complete_status");
  return (
    <div className="erp-form__actions">
      {flow.stepUp && <StepUpPrompt onConfirm={(code) => void flow.confirmStepUp(code)} onCancel={flow.cancelStepUp} error={flow.stepUpError} busy={flow.saving} />}
      <div className="erp-row">
        <span className="erp-small erp-muted erp-grow" role="status">
          {flow.saving ? t("saving") : status} · <span className="erp-mono">{t("process", { process })}</span>
        </span>
        {dirty && !isNew && (
          <button type="button" className="erp-btn" onClick={onDiscard} disabled={flow.saving}>
            {t("discard")}
          </button>
        )}
        <button type="button" className="erp-btn erp-btn--primary" onClick={onSave} disabled={blocked || flow.saving || (!dirty && !isNew)}>
          {isNew ? t("create") : common("save")}
        </button>
      </div>
    </div>
  );
}
