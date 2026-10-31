"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { FieldLabels } from "../fields/field-model";
import { invoiceBlockers } from "../lookup/lookup-model";
import { CodeCombobox } from "./fields/CodeCombobox";
import { DianHintsProvider, useDianHints, useFormPrefs } from "./form-context";
import { enterTarget, focusField, isEnterSource } from "./form-keyboard";
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

/** The keys that save a record form from any of its fields. */
export const SAVE_SHORTCUTS = "Control+S Meta+S Control+Enter Meta+Enter";

export interface RecordFormProps {
  /** A save would run now (not read-only, not blocked by the client's checks, not saving, something to save). */
  canSave: boolean;
  onSave: () => void;
  /** The last refusal: when it changes, the caret goes to the first field in error or to the error summary. */
  failure: SaveFlow["failure"];
  /** Shows the "Ver códigos DIAN" switch (default); a form with no DIAN codes leaves it out. */
  dianToggle?: boolean;
  children: ReactNode;
}

/** Whether the DIAN schema hints show: the user's saved choice when the shell provides it, else this form's own switch. Off by default (OD-12). */
function useDianHintsState(): [boolean, (on: boolean) => void] {
  const prefs = useFormPrefs();
  const [local, setLocal] = useState(false);
  return prefs ? [prefs.dianHints, prefs.setDianHints] : [local, setLocal];
}

/**
 * The record forms' frame (party, product, category): a real <form> where Ctrl/⌘+S and Ctrl/⌘+Enter save from any
 * field, Enter moves to the next field and Shift+Enter back (OD-11; a textarea keeps its newline and the last field
 * keeps the caret), Enter never submits (a form of many text boxes), and after a refusal (or a shortcut on a blocked
 * form) the caret goes to the first field in error, else to the error summary (`data-error-summary`). The "Ver
 * códigos DIAN" switch shows or hides the schema hints and the codes before names for every field below (OD-12).
 */
export function RecordForm({ canSave, onSave, failure, dianToggle = true, children }: RecordFormProps) {
  const t = useTranslations("common.forms");
  const ref = useRef<HTMLFormElement>(null);
  const [dianHints, setDianHints] = useDianHintsState();
  const switchId = useId();
  const focusFirstProblem = (summaryFirst = false) => {
    const form = ref.current;
    const field = form?.querySelector<HTMLElement>('[aria-invalid="true"]:not(:disabled)');
    const summary = form?.querySelector<HTMLElement>("[data-error-summary]");
    const target = summaryFirst ? (summary ?? field) : (field ?? summary);
    if (!target) return;
    target.focus();
    target.scrollIntoView?.({ block: "center" });
  };
  // A save asked for by the keyboard runs after the render that follows the key: a widget that commits on the same key
  // (the combobox choosing its active option) has then updated the draft, and the save reads that committed draft.
  const latest = useRef({ canSave, onSave });
  useEffect(() => {
    latest.current = { canSave, onSave };
  });
  const [saveAsked, setSaveAsked] = useState(0);
  useEffect(() => {
    if (saveAsked === 0) return;
    if (latest.current.canSave) latest.current.onSave();
    else focusFirstProblem();
  }, [saveAsked]);
  useEffect(() => {
    // A refusal that names fields goes to the first of them; one that does not (a duplicate, the pack's checks) goes
    // to the summary that says it.
    if (failure) focusFirstProblem(!failure.details.some((d) => (d.path?.length ?? 0) > 0));
  }, [failure]);
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // A widget that used the Enter itself (an open list choosing an option) has prevented it; so do not move on.
      if (event.defaultPrevented || event.nativeEvent.isComposing || !event.currentTarget.contains(event.target as Node) || !isEnterSource(event.target)) return;
      // Enter never submits, on the last field either.
      event.preventDefault();
      const next = enterTarget(event.currentTarget, event.target, event.shiftKey);
      if (next) focusField(next);
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey || (event.key.toLowerCase() !== "s" && event.key !== "Enter")) return;
    // React events bubble through portals: a dialog opened from the form (the lookup's advanced filter) keeps its keys.
    if (!event.currentTarget.contains(event.target as Node)) return;
    // A widget that claimed the key and did not commit anything keeps it; one that commits (the combobox) lets it through.
    if (event.defaultPrevented) return;
    event.preventDefault();
    setSaveAsked((n) => n + 1);
  };
  return (
    <form ref={ref} className="erp-form" noValidate onKeyDown={onKeyDown} onSubmit={(event) => event.preventDefault()} aria-keyshortcuts={SAVE_SHORTCUTS}>
      {dianToggle && (
        <div className="erp-form__tools">
          <span className="erp-switch">
            <button type="button" id={switchId} role="switch" aria-checked={dianHints} aria-labelledby={`${switchId}-label`} className={dianHints ? "erp-toggle is-on" : "erp-toggle"} onClick={() => setDianHints(!dianHints)} />
            <span id={`${switchId}-label`}>{t("dian_hints")}</span>
          </span>
        </div>
      )}
      <DianHintsProvider value={dianHints}>{children}</DianHintsProvider>
    </form>
  );
}

/**
 * A labelled control; `children` receives the control's id and the ids that describe it (hint, error). The error is
 * not an alert of its own: the form announces one summary and moves the caret to the first field in error.
 */
/** `dian` marks a schema annotation (`DANE`, `schemeName`): shown only with "Ver códigos DIAN". `help` (the default) always shows. */
export type HintKind = "dian" | "help";

export function Field({
  label,
  hint,
  hintKind = "help",
  error,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  hintKind?: HintKind;
  error?: string | null;
  className?: string;
  children: (id: string, describedBy?: string) => ReactNode;
}) {
  const id = useId();
  const dian = useDianHints();
  const shown = hint && (hintKind === "help" || dian) ? hint : null;
  const describedBy = [shown ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={["erp-field", className].filter(Boolean).join(" ")}>
      <label id={`${id}-label`} htmlFor={id}>
        {/* The label's own words, without the hint: what a control named after the field points at (a combobox's list). */}
        <span id={`${id}-label-text`}>{label}</span>
        {shown && (
          <span id={`${id}-hint`} className="erp-field__hint">
            {" "}
            {shown}
          </span>
        )}
      </label>
      {children(id, describedBy)}
      {error && (
        <span id={`${id}-error`} className="erp-field__error">
          {error}
        </span>
      )}
    </div>
  );
}

export interface SelectFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  hintKind?: HintKind;
  error?: string | null;
  value: string;
  options: readonly CodeOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** A first option with this text and an empty value. */
  empty?: string;
  /** Shows `code · name` (prototype `sel`) while "Ver códigos DIAN" is on; the name alone otherwise. */
  showCode?: boolean;
  className?: string;
}

export function SelectField({ label, hint, hintKind, error, value, options, onChange, disabled, empty, showCode = true, className }: SelectFieldProps) {
  const dian = useDianHints();
  return (
    <Field label={label} hint={hint} hintKind={hintKind} error={error} className={className}>
      {(id, describedBy) => (
        <select id={id} value={value} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={error ? "erp-input--bad" : undefined} onChange={(e) => onChange(e.target.value)}>
          {empty !== undefined && <option value="">{empty}</option>}
          {!options.some((o) => o.code === value) && value !== "" && <option value={value}>{value}</option>}
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {showCode && dian ? `${o.code} · ${o.name}` : o.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** A `SelectField` for a long code table: type to search by name or code (see `CodeCombobox`). */
export function CodeComboboxField({ label, hint, hintKind, error, value, options, onChange, disabled, empty, showCode, className }: SelectFieldProps) {
  return (
    <Field label={label} hint={hint} hintKind={hintKind} error={error} className={className}>
      {(id, describedBy) => <CodeCombobox id={id} aria-labelledby={`${id}-label-text`} value={value} options={options} onChange={onChange} empty={empty} showCode={showCode} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={describedBy} />}
    </Field>
  );
}

export interface TextFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  hintKind?: HintKind;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  maxLength?: number;
  inputMode?: "numeric" | "text" | "decimal";
  mono?: boolean;
  error?: string | null;
  className?: string;
}

export function TextField({ label, hint, hintKind, value, onChange, disabled, maxLength, inputMode, mono, error, className }: TextFieldProps) {
  return (
    <Field label={label} hint={hint} hintKind={hintKind} error={error} className={className}>
      {(id, describedBy) => (
        <input
          id={id}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          inputMode={inputMode}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={[mono && "erp-mono", error && "erp-input--bad"].filter(Boolean).join(" ") || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** A set of codes as checkboxes (responsibilities, other taxes). */
export function Checks({ label, hint, hintKind = "help", options, value, onToggle, disabled, row }: { label: ReactNode; hint?: ReactNode; hintKind?: HintKind; options: readonly CodeOption[]; value: readonly string[]; onToggle: (code: string, on: boolean) => void; disabled?: boolean; row?: boolean }) {
  const dian = useDianHints();
  return (
    <fieldset className="erp-field">
      <legend>
        {label}
        {hint && (hintKind === "help" || dian) && <span className="erp-field__hint"> {hint}</span>}
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

/** A field's message from the process, under a control that has no error slot of its own (e-mail, phone). Not an alert: the form's summary speaks. */
export function FieldError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <span className="erp-field__error">
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
      <div className="erp-dian erp-dian--bad" role="alert" tabIndex={-1} data-error-summary="">
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
          {flow.saving ? t("saving") : status} · <span className="erp-mono">{t("process", { process })}</span> · <kbd className="erp-mono">{t("save_hint")}</kbd>
        </span>
        {dirty && !isNew && (
          <button type="button" className="erp-btn" onClick={onDiscard} disabled={flow.saving}>
            {t("discard")}
          </button>
        )}
        {/* type="button": a submit button would make Enter in any text box save (implicit submission). */}
        <button type="button" className="erp-btn erp-btn--primary" aria-keyshortcuts={SAVE_SHORTCUTS} onClick={onSave} disabled={blocked || flow.saving || (!dirty && !isNew)}>
          {isNew ? t("create") : common("save")}
        </button>
      </div>
    </div>
  );
}
