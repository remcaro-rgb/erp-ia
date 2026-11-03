"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { RecordForm, SAVE_SHORTCUTS, Section, SelectField, TextField, failureMessages, useErrorText } from "../forms/form-parts";
import type { CodeOption, RequestStepUp, SaveRecord } from "../forms/save-model";
import { StepUpPrompt } from "../forms/StepUpPrompt";
import { useSaveFlow } from "../forms/use-save";
import { activeSpecs, masterDraft, masterInput, masterMissing, type MasterKind } from "./master-form-model";
import { ProcessId } from "../forms/ProcessId";
import { useRecordBridge } from "../record/record-bridge";

// The Datos tab of the masters (accounting design §8): Cuenta, the four analytic dimensions, Fuente, Plantilla de comprobante and
// Período, one form driven by the field specs of `master-form-model`. It saves through the entity's create / update process and asks
// for the step-up code when the process requires it, like the other record forms.

export interface MasterFormProps {
  kind: MasterKind;
  /** The process ids the form saves through, shown in its footer. */
  processes: { create: string; update: string };
  /** The stored record as the entity's consult returns it, or null for a new one. */
  record: (Record<string, unknown> & { id: string }) | null;
  /** A new record started from a copy ("Duplicar", rule 37). */
  initial?: Readonly<Record<string, unknown>> | null;
  readOnly?: boolean;
  options?: { parents?: readonly CodeOption[]; journals?: readonly CodeOption[] };
  /** Read-only lines under the fields (a plantilla's lines). */
  footer?: React.ReactNode;
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  onSaved?: (id: string, created: boolean) => void;
}

export function MasterForm({ kind, processes, record, initial: copy, readOnly = false, options, footer, save, requestStepUp, onSaved }: MasterFormProps) {
  const t = useTranslations("accounting.record.form");
  const tf = useTranslations("common.forms");
  const bridge = useRecordBridge();
  const tc = useTranslations("common");
  const tv = useTranslations("accounting.values");
  const errorText = useErrorText();
  const isNew = record === null;
  const recordKey = record ? `${record.id}:${String(record.updated_at ?? "")}` : "new";
  const [seen, setSeen] = useState(recordKey);
  const [initial, setInitial] = useState(() => masterDraft(kind, record ?? copy ?? null));
  const [draft, setDraft] = useState(initial);
  if (seen !== recordKey) {
    const next = masterDraft(kind, record ?? copy ?? null);
    setSeen(recordKey);
    setInitial(next);
    setDraft(next);
  }
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, isNew));
  const specs = activeSpecs(kind, isNew);
  const failed = failureMessages(flow.failure, specs.map((s) => s.key), errorText);
  const missing = masterMissing(kind, draft, isNew);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const editable = specs.some((s) => s.control !== "fixed") && !readOnly;
  const send = () => flow.submit(masterInput(kind, draft, record ? record.id : null));
  const submit = () => void send();
  const set = (key: string) => (value: string | boolean) => setDraft((d) => ({ ...d, [key]: value }));
  const valueText = (key: string, valuesKey?: string) => {
    const v = draft[key];
    if (typeof v === "boolean") return v ? t("yes") : t("no");
    if (valuesKey && tv.has(`${valuesKey}.${v}`)) return tv(`${valuesKey}.${v}`);
    return String(v ?? "") || "—";
  };
  const optionsOf = (from: "parents" | "journals" | undefined): CodeOption[] => (from === "parents" ? [...(options?.parents ?? [])] : from === "journals" ? [...(options?.journals ?? [])] : []);

  const fields = specs.map((spec) => {
    const label = t(`field.${kind}.${spec.column}`);
    const hint = spec.hint ? t(spec.hint) : undefined;
    const error = failed.field(spec.key);
    if (spec.control === "fixed") {
      return (
        <div key={spec.key} className="erp-field">
          <span className="erp-field__label">{label}</span>
          <span className={spec.mono ? "erp-mono" : undefined} data-fixed={spec.key}>
            {valueText(spec.key, spec.valuesKey)}
          </span>
        </div>
      );
    }
    if (spec.control === "check") {
      const hintId = hint ? `${kind}-${spec.key}-hint` : undefined;
      return (
        <label key={spec.key} className="erp-row erp-field">
          <input type="checkbox" checked={draft[spec.key] === true} disabled={readOnly} aria-describedby={hintId} onChange={(e) => set(spec.key)(e.target.checked)} />
          <span>{label}</span>
          {hint && (
            <span id={hintId} className="erp-field__hint">
              {hint}
            </span>
          )}
        </label>
      );
    }
    if (spec.control === "select") {
      const choices: CodeOption[] = spec.codes ? spec.codes.map((code) => ({ code, name: tv.has(`${spec.valuesKey}.${code}`) ? tv(`${spec.valuesKey}.${code}`) : code })) : optionsOf(spec.optionsFrom);
      return (
        <SelectField
          key={spec.key}
          label={label}
          value={String(draft[spec.key] ?? "")}
          options={choices}
          showCode={false}
          {...(spec.optionsFrom === "parents" ? { empty: t("no_parent") } : spec.optionsFrom === "journals" && String(draft[spec.key] ?? "") === "" ? { empty: "—" } : {})}
          disabled={readOnly}
          error={error}
          onChange={set(spec.key)}
        />
      );
    }
    return (
      <TextField
        key={spec.key}
        label={label}
        hint={hint}
        value={String(draft[spec.key] ?? "")}
        mono={spec.mono}
        inputMode={spec.numeric ? "numeric" : undefined}
        disabled={readOnly || (spec.createOnly === true && !isNew)}
        error={error}
        onChange={set(spec.key)}
      />
    );
  });

  return (
    <RecordForm canSave={editable && !missing && !flow.saving && !flow.stepUp && (dirty || isNew)} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure}>
      {readOnly && editable && <div className="erp-dian erp-dian--info">{tf("read_only")}</div>}
      <Section title={t(`section.${kind}`)}>
        <div className="erp-form2">{fields}</div>
      </Section>
      {footer}
      {failed.panel.length > 0 && (
        <div className="erp-dian erp-dian--bad" role="alert" tabIndex={-1} data-error-summary="">
          <b>{failed.panel.join(" · ")}</b>
        </div>
      )}
      {editable && (
        <div className="erp-form__actions">
          {flow.stepUp && <StepUpPrompt onConfirm={(code) => void flow.confirmStepUp(code)} onCancel={flow.cancelStepUp} error={flow.stepUpError} busy={flow.saving} />}
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {flow.saving ? tf("saving") : missing ? t("missing") : ""} <kbd className="erp-mono">{tf("save_hint")}</kbd> · <ProcessId id={isNew ? processes.create : processes.update} />
            </span>
            {dirty && !isNew && (
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
